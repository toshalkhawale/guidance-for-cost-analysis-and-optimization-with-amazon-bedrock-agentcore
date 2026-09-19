"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentCoreGatewayStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const cdk_nag_1 = require("cdk-nag");
class AgentCoreGatewayStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ========================================
        // Retrieve AuthStack M2M client secret
        // ========================================
        const describeM2MClient = new cr.AwsCustomResource(this, 'DescribeM2MClient', {
            onCreate: {
                service: 'CognitoIdentityServiceProvider',
                action: 'describeUserPoolClient',
                parameters: {
                    UserPoolId: props.authUserPoolId,
                    ClientId: props.authM2mClientId,
                },
                physicalResourceId: cr.PhysicalResourceId.of('m2m-client-secret'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['cognito-idp:DescribeUserPoolClient'],
                    resources: [props.authUserPoolArn],
                }),
            ]),
        });
        const m2mClientSecret = describeM2MClient.getResponseField('UserPoolClient.ClientSecret');
        // ========================================
        // Gateway Token Exchange Policy (managed policy, wildcard)
        // ========================================
        const tokenExchangePolicy = new iam.ManagedPolicy(this, 'GatewayTokenExchangePolicy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AgentCoreIdentityTokenExchange',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'bedrock-agentcore:GetWorkloadAccessToken',
                        'bedrock-agentcore:GetResourceOauth2Token',
                    ],
                    resources: ['*'],
                }),
            ],
        });
        // ========================================
        // Gateway Service Role
        // ========================================
        const gatewayRole = new iam.Role(this, 'GatewayServiceRole', {
            description: 'Service role for FinOps AgentCore Gateway',
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
            managedPolicies: [tokenExchangePolicy],
        });
        // ========================================
        // OAuth Provider (Lambda custom resource)
        // Uses AuthStack's Cognito for outbound auth to MCP runtimes
        // ========================================
        const oauthProviderFn = new lambda.Function(this, 'OAuthProviderFunction', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            code: lambda.Code.fromInline(`
import json
import logging
import urllib.request
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def send_cfn_response(event, status, data=None, reason=None, physical_id=None):
    response_body = json.dumps({
        'Status': status,
        'Reason': reason or 'See CloudWatch Logs',
        'PhysicalResourceId': physical_id or event.get('PhysicalResourceId', event['RequestId']),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    })
    response_url = event['ResponseURL']
    if not response_url.startswith('https://'):
        raise ValueError(f'Invalid response URL scheme')
    req = urllib.request.Request(
        response_url,
        data=response_body.encode('utf-8'),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)

def handler(event, context):
    logger.info(f'Event: {json.dumps(event)}')
    request_type = event['RequestType']
    props = event['ResourceProperties']
    provider_name = props.get('ProviderName', '')
    region = props.get('Region', 'us-east-1')
    client = boto3.client('bedrock-agentcore-control', region_name=region)

    if request_type == 'Delete':
        try:
            client.delete_oauth2_credential_provider(name=provider_name)
            send_cfn_response(event, 'SUCCESS')
        except Exception:
            send_cfn_response(event, 'SUCCESS')
        return

    try:
        response = client.create_oauth2_credential_provider(
            name=provider_name,
            credentialProviderVendor='CustomOauth2',
            oauth2ProviderConfigInput={
                'customOauth2ProviderConfig': {
                    'oauthDiscovery': {
                        'discoveryUrl': props.get('DiscoveryUrl', ''),
                    },
                    'clientId': props.get('ClientId', ''),
                    'clientSecret': props.get('ClientSecret', ''),
                },
            },
        )
        provider_arn = response.get('credentialProviderArn', '')
        secret_arn = response.get('clientSecretArn', {}).get('secretArn', '')
        logger.info(f'Created provider: {provider_arn}')
        send_cfn_response(event, 'SUCCESS', data={
            'ProviderArn': provider_arn,
            'SecretArn': secret_arn,
        }, physical_id=provider_name)
    except Exception as e:
        logger.error(f'Create failed: {e}')
        send_cfn_response(event, 'FAILED', reason=str(e))
`),
        });
        oauthProviderFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:CreateOauth2CredentialProvider',
                'bedrock-agentcore:DeleteOauth2CredentialProvider',
                'bedrock-agentcore:GetOauth2CredentialProvider',
                'bedrock-agentcore:CreateTokenVault',
                'bedrock-agentcore:GetTokenVault',
            ],
            resources: ['*'],
        }));
        oauthProviderFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'secretsmanager:CreateSecret',
                'secretsmanager:DeleteSecret',
                'secretsmanager:PutSecretValue',
                'secretsmanager:TagResource',
            ],
            resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity*`,
            ],
        }));
        const oauthProvider = new cdk.CustomResource(this, 'OAuthProvider', {
            serviceToken: oauthProviderFn.functionArn,
            properties: {
                ProviderName: `${this.stackName}-oauth-provider`,
                DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.authUserPoolId}/.well-known/openid-configuration`,
                ClientId: props.authM2mClientId,
                ClientSecret: m2mClientSecret,
                Region: this.region,
            },
        });
        const oauthProviderArn = oauthProvider.getAttString('ProviderArn');
        const oauthSecretArn = oauthProvider.getAttString('SecretArn');
        // ========================================
        // Default Policy on Gateway Role (scoped to OAuth provider resources)
        // ========================================
        gatewayRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:GetResourceOauth2Token',
                'bedrock-agentcore:GetWorkloadAccessToken',
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
            ],
            resources: [oauthProviderArn, oauthSecretArn],
        }));
        // ========================================
        // Gateway (AWS_IAM auth — Main Runtime calls via InvokeGateway API)
        // ========================================
        const gateway = new cdk.CfnResource(this, 'McpGateway', {
            type: 'AWS::BedrockAgentCore::Gateway',
            properties: {
                Name: 'finops-gateway',
                Description: 'FinOps Gateway for billing and pricing MCP tools (IAM auth)',
                ProtocolType: 'MCP',
                AuthorizerType: 'AWS_IAM',
                ProtocolConfiguration: {
                    Mcp: {
                        Instructions: 'FinOps gateway for billing and pricing MCP tools',
                        SearchType: 'SEMANTIC',
                        SupportedVersions: ['2025-03-26'],
                    },
                },
                RoleArn: gatewayRole.roleArn,
            },
        });
        gateway.node.addDependency(oauthProvider);
        this.gatewayArn = gateway.getAtt('GatewayArn').toString();
        const gatewayId = gateway.getAtt('GatewayIdentifier').toString();
        this.gatewayUrl = gateway.getAtt('GatewayUrl').toString();
        // ========================================
        // Gateway Targets (MCP Server endpoints)
        // ========================================
        const billingTarget = new cdk.CfnResource(this, 'BillingMcpTarget', {
            type: 'AWS::BedrockAgentCore::GatewayTarget',
            properties: {
                GatewayIdentifier: gatewayId,
                Name: 'billingMcp',
                Description: 'AWS Labs Billing MCP Server on AgentCore Runtime',
                TargetConfiguration: {
                    Mcp: { McpServer: { Endpoint: props.billingMcpRuntimeEndpoint } },
                },
                CredentialProviderConfigurations: [{
                        CredentialProviderType: 'OAUTH',
                        CredentialProvider: {
                            OauthCredentialProvider: {
                                ProviderArn: oauthProviderArn,
                                Scopes: ['mcp-runtime-server/invoke'],
                            },
                        },
                    }],
            },
        });
        billingTarget.node.addDependency(gateway);
        const pricingTarget = new cdk.CfnResource(this, 'PricingMcpTarget', {
            type: 'AWS::BedrockAgentCore::GatewayTarget',
            properties: {
                GatewayIdentifier: gatewayId,
                Name: 'pricingMcp',
                Description: 'AWS Labs Pricing MCP Server on AgentCore Runtime',
                TargetConfiguration: {
                    Mcp: { McpServer: { Endpoint: props.pricingMcpRuntimeEndpoint } },
                },
                CredentialProviderConfigurations: [{
                        CredentialProviderType: 'OAUTH',
                        CredentialProvider: {
                            OauthCredentialProvider: {
                                ProviderArn: oauthProviderArn,
                                Scopes: ['mcp-runtime-server/invoke'],
                            },
                        },
                    }],
            },
        });
        pricingTarget.node.addDependency(gateway);
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'GatewayArn', {
            value: this.gatewayArn,
            description: 'AgentCore Gateway ARN',
            exportName: `${this.stackName}-GatewayArn`,
        });
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gatewayUrl,
            description: 'AgentCore Gateway URL',
            exportName: `${this.stackName}-GatewayUrl`,
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(gatewayRole, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange and OAuth provider management.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(oauthProviderFn, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard required for AgentCore Identity token vault creation and bedrock-agentcore-identity secrets namespace.' },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange, OAuth credential provider management.', appliesTo: ['Resource::*'] },
            { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
        ]);
    }
}
exports.AgentCoreGatewayStack = AgentCoreGatewayStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdhdGV3YXktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBRW5ELHFDQUEwQztBQWMxQyxNQUFhLHFCQUFzQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLHVDQUF1QztRQUN2QywyQ0FBMkM7UUFFM0MsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUUsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxnQ0FBZ0M7Z0JBQ3pDLE1BQU0sRUFBRSx3QkFBd0I7Z0JBQ2hDLFVBQVUsRUFBRTtvQkFDVixVQUFVLEVBQUUsS0FBSyxDQUFDLGNBQWM7b0JBQ2hDLFFBQVEsRUFBRSxLQUFLLENBQUMsZUFBZTtpQkFDaEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQzthQUNsRTtZQUNELE1BQU0sRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsY0FBYyxDQUFDO2dCQUNoRCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO29CQUMvQyxTQUFTLEVBQUUsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDO2lCQUNuQyxDQUFDO2FBQ0gsQ0FBQztTQUNILENBQUMsQ0FBQztR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LENBQUMsdUJBQXVCLENBQUMsZUFBZSxFQUFFO1lBQ3ZELEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxpSEFBaUgsRUFBRTtTQUN2SixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekMsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLG1EQUFtRCxFQUFFLFNBQVMsRUFBRSxDQUFDLHVGQUF1RixDQUFDLEVBQUU7WUFDOUwsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLHVGQUF1RixFQUFFLFNBQVMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxFQUFFO1lBQ3hKLEVBQUUsRUFBRSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sRUFBRSx3Q0FBd0MsRUFBRTtTQUM1RSxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFqVEQsc0RBaVRDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xyXG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XHJcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcclxuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50Q29yZUdhdGV3YXlTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xyXG4gIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50cyBmcm9tIE1DUFJ1bnRpbWVTdGFja1xyXG4gIGJpbGxpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XHJcbiAgYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xyXG4gIHByaWNpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XHJcbiAgcHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xyXG4gIC8vIEF1dGhTdGFjayBDb2duaXRvIC0gdXNlZCBmb3IgT0F1dGggcHJvdmlkZXIgKG91dGJvdW5kIGF1dGggdG8gcnVudGltZXMpXHJcbiAgYXV0aFVzZXJQb29sSWQ6IHN0cmluZztcclxuICBhdXRoVXNlclBvb2xBcm46IHN0cmluZztcclxuICBhdXRoTTJtQ2xpZW50SWQ6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEFnZW50Q29yZUdhdGV3YXlTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XHJcbiAgcHVibGljIHJlYWRvbmx5IGdhdGV3YXlBcm46IHN0cmluZztcclxuICBwdWJsaWMgcmVhZG9ubHkgZ2F0ZXdheVVybDogc3RyaW5nO1xyXG5cclxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQWdlbnRDb3JlR2F0ZXdheVN0YWNrUHJvcHMpIHtcclxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIFJldHJpZXZlIEF1dGhTdGFjayBNMk0gY2xpZW50IHNlY3JldFxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIGNvbnN0IGRlc2NyaWJlTTJNQ2xpZW50ID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdEZXNjcmliZU0yTUNsaWVudCcsIHtcclxuICAgICAgb25DcmVhdGU6IHtcclxuICAgICAgICBzZXJ2aWNlOiAnQ29nbml0b0lkZW50aXR5U2VydmljZVByb3ZpZGVyJyxcclxuICAgICAgICBhY3Rpb246ICdkZXNjcmliZVVzZXJQb29sQ2xpZW50JyxcclxuICAgICAgICBwYXJhbWV0ZXJzOiB7XHJcbiAgICAgICAgICBVc2VyUG9vbElkOiBwcm9wcy5hdXRoVXNlclBvb2xJZCxcclxuICAgICAgICAgIENsaWVudElkOiBwcm9wcy5hdXRoTTJtQ2xpZW50SWQsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZignbTJtLWNsaWVudC1zZWNyZXQnKSxcclxuICAgICAgfSxcclxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogWydjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sQ2xpZW50J10sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtwcm9wcy5hdXRoVXNlclBvb2xBcm5dLFxyXG4gICAgICAgIH0pLFxyXG4gICAgICBdKSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IG0ybUNsaWVudFNlY3JldCA9IGRlc2NyaWJlTTJNQ2xpZW50LmdldFJlc3BvbnNlRmllbGQoJ1VzZXJQb29sQ2xpZW50LkNsaWVudFNlY3JldCcpO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIEdhdGV3YXkgVG9rZW4gRXhjaGFuZ2UgUG9saWN5IChtYW5hZ2VkIHBvbGljeSwgd2lsZGNhcmQpXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgY29uc3QgdG9rZW5FeGNoYW5nZVBvbGljeSA9IG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCAnR2F0ZXdheVRva2VuRXhjaGFuZ2VQb2xpY3knLCB7XHJcbiAgICAgIHN0YXRlbWVudHM6IFtcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6ICdBZ2VudENvcmVJZGVudGl0eVRva2VuRXhjaGFuZ2UnLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRBY2Nlc3NUb2tlbicsXHJcbiAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRSZXNvdXJjZU9hdXRoMlRva2VuJyxcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICAgIH0pLFxyXG4gICAgICBdLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gR2F0ZXdheSBTZXJ2aWNlIFJvbGVcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBjb25zdCBnYXRld2F5Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnR2F0ZXdheVNlcnZpY2VSb2xlJywge1xyXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlcnZpY2Ugcm9sZSBmb3IgRmluT3BzIEFnZW50Q29yZSBHYXRld2F5JyxcclxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbdG9rZW5FeGNoYW5nZVBvbGljeV0sXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBPQXV0aCBQcm92aWRlciAoTGFtYmRhIGN1c3RvbSByZXNvdXJjZSlcclxuICAgIC8vIFVzZXMgQXV0aFN0YWNrJ3MgQ29nbml0byBmb3Igb3V0Ym91bmQgYXV0aCB0byBNQ1AgcnVudGltZXNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBjb25zdCBvYXV0aFByb3ZpZGVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdPQXV0aFByb3ZpZGVyRnVuY3Rpb24nLCB7XHJcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxyXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXHJcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDIpLFxyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcclxuaW1wb3J0IGpzb25cclxuaW1wb3J0IGxvZ2dpbmdcclxuaW1wb3J0IHVybGxpYi5yZXF1ZXN0XHJcbmltcG9ydCBib3RvM1xyXG5cclxubG9nZ2VyID0gbG9nZ2luZy5nZXRMb2dnZXIoKVxyXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxyXG5cclxuZGVmIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCBzdGF0dXMsIGRhdGE9Tm9uZSwgcmVhc29uPU5vbmUsIHBoeXNpY2FsX2lkPU5vbmUpOlxyXG4gICAgcmVzcG9uc2VfYm9keSA9IGpzb24uZHVtcHMoe1xyXG4gICAgICAgICdTdGF0dXMnOiBzdGF0dXMsXHJcbiAgICAgICAgJ1JlYXNvbic6IHJlYXNvbiBvciAnU2VlIENsb3VkV2F0Y2ggTG9ncycsXHJcbiAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IHBoeXNpY2FsX2lkIG9yIGV2ZW50LmdldCgnUGh5c2ljYWxSZXNvdXJjZUlkJywgZXZlbnRbJ1JlcXVlc3RJZCddKSxcclxuICAgICAgICAnU3RhY2tJZCc6IGV2ZW50WydTdGFja0lkJ10sXHJcbiAgICAgICAgJ1JlcXVlc3RJZCc6IGV2ZW50WydSZXF1ZXN0SWQnXSxcclxuICAgICAgICAnTG9naWNhbFJlc291cmNlSWQnOiBldmVudFsnTG9naWNhbFJlc291cmNlSWQnXSxcclxuICAgICAgICAnRGF0YSc6IGRhdGEgb3Ige30sXHJcbiAgICB9KVxyXG4gICAgcmVzcG9uc2VfdXJsID0gZXZlbnRbJ1Jlc3BvbnNlVVJMJ11cclxuICAgIGlmIG5vdCByZXNwb25zZV91cmwuc3RhcnRzd2l0aCgnaHR0cHM6Ly8nKTpcclxuICAgICAgICByYWlzZSBWYWx1ZUVycm9yKGYnSW52YWxpZCByZXNwb25zZSBVUkwgc2NoZW1lJylcclxuICAgIHJlcSA9IHVybGxpYi5yZXF1ZXN0LlJlcXVlc3QoXHJcbiAgICAgICAgcmVzcG9uc2VfdXJsLFxyXG4gICAgICAgIGRhdGE9cmVzcG9uc2VfYm9keS5lbmNvZGUoJ3V0Zi04JyksXHJcbiAgICAgICAgaGVhZGVycz17J0NvbnRlbnQtVHlwZSc6ICcnfSxcclxuICAgICAgICBtZXRob2Q9J1BVVCcsXHJcbiAgICApXHJcbiAgICB1cmxsaWIucmVxdWVzdC51cmxvcGVuKHJlcSlcclxuXHJcbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcclxuICAgIGxvZ2dlci5pbmZvKGYnRXZlbnQ6IHtqc29uLmR1bXBzKGV2ZW50KX0nKVxyXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cclxuICAgIHByb3BzID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddXHJcbiAgICBwcm92aWRlcl9uYW1lID0gcHJvcHMuZ2V0KCdQcm92aWRlck5hbWUnLCAnJylcclxuICAgIHJlZ2lvbiA9IHByb3BzLmdldCgnUmVnaW9uJywgJ3VzLWVhc3QtMScpXHJcbiAgICBjbGllbnQgPSBib3RvMy5jbGllbnQoJ2JlZHJvY2stYWdlbnRjb3JlLWNvbnRyb2wnLCByZWdpb25fbmFtZT1yZWdpb24pXHJcblxyXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxyXG4gICAgICAgIHRyeTpcclxuICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlcihuYW1lPXByb3ZpZGVyX25hbWUpXHJcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXHJcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcclxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcclxuICAgICAgICByZXR1cm5cclxuXHJcbiAgICB0cnk6XHJcbiAgICAgICAgcmVzcG9uc2UgPSBjbGllbnQuY3JlYXRlX29hdXRoMl9jcmVkZW50aWFsX3Byb3ZpZGVyKFxyXG4gICAgICAgICAgICBuYW1lPXByb3ZpZGVyX25hbWUsXHJcbiAgICAgICAgICAgIGNyZWRlbnRpYWxQcm92aWRlclZlbmRvcj0nQ3VzdG9tT2F1dGgyJyxcclxuICAgICAgICAgICAgb2F1dGgyUHJvdmlkZXJDb25maWdJbnB1dD17XHJcbiAgICAgICAgICAgICAgICAnY3VzdG9tT2F1dGgyUHJvdmlkZXJDb25maWcnOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgJ29hdXRoRGlzY292ZXJ5Jzoge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAnZGlzY292ZXJ5VXJsJzogcHJvcHMuZ2V0KCdEaXNjb3ZlcnlVcmwnLCAnJyksXHJcbiAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAnY2xpZW50SWQnOiBwcm9wcy5nZXQoJ0NsaWVudElkJywgJycpLFxyXG4gICAgICAgICAgICAgICAgICAgICdjbGllbnRTZWNyZXQnOiBwcm9wcy5nZXQoJ0NsaWVudFNlY3JldCcsICcnKSxcclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgKVxyXG4gICAgICAgIHByb3ZpZGVyX2FybiA9IHJlc3BvbnNlLmdldCgnY3JlZGVudGlhbFByb3ZpZGVyQXJuJywgJycpXHJcbiAgICAgICAgc2VjcmV0X2FybiA9IHJlc3BvbnNlLmdldCgnY2xpZW50U2VjcmV0QXJuJywge30pLmdldCgnc2VjcmV0QXJuJywgJycpXHJcbiAgICAgICAgbG9nZ2VyLmluZm8oZidDcmVhdGVkIHByb3ZpZGVyOiB7cHJvdmlkZXJfYXJufScpXHJcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJywgZGF0YT17XHJcbiAgICAgICAgICAgICdQcm92aWRlckFybic6IHByb3ZpZGVyX2FybixcclxuICAgICAgICAgICAgJ1NlY3JldEFybic6IHNlY3JldF9hcm4sXHJcbiAgICAgICAgfSwgcGh5c2ljYWxfaWQ9cHJvdmlkZXJfbmFtZSlcclxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcclxuICAgICAgICBsb2dnZXIuZXJyb3IoZidDcmVhdGUgZmFpbGVkOiB7ZX0nKVxyXG4gICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnRkFJTEVEJywgcmVhc29uPXN0cihlKSlcclxuYCksXHJcbiAgICB9KTtcclxuXHJcbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZU9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZU9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldE9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVRva2VuVmF1bHQnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRUb2tlblZhdWx0JyxcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkNyZWF0ZVNlY3JldCcsXHJcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlbGV0ZVNlY3JldCcsXHJcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlB1dFNlY3JldFZhbHVlJyxcclxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6VGFnUmVzb3VyY2UnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICBgYXJuOmF3czpzZWNyZXRzbWFuYWdlcjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c2VjcmV0OmJlZHJvY2stYWdlbnRjb3JlLWlkZW50aXR5KmAsXHJcbiAgICAgIF0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ09BdXRoUHJvdmlkZXInLCB7XHJcbiAgICAgIHNlcnZpY2VUb2tlbjogb2F1dGhQcm92aWRlckZuLmZ1bmN0aW9uQXJuLFxyXG4gICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgUHJvdmlkZXJOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tb2F1dGgtcHJvdmlkZXJgLFxyXG4gICAgICAgIERpc2NvdmVyeVVybDogYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3Byb3BzLmF1dGhVc2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXHJcbiAgICAgICAgQ2xpZW50SWQ6IHByb3BzLmF1dGhNMm1DbGllbnRJZCxcclxuICAgICAgICBDbGllbnRTZWNyZXQ6IG0ybUNsaWVudFNlY3JldCxcclxuICAgICAgICBSZWdpb246IHRoaXMucmVnaW9uLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlckFybiA9IG9hdXRoUHJvdmlkZXIuZ2V0QXR0U3RyaW5nKCdQcm92aWRlckFybicpO1xyXG4gICAgY29uc3Qgb2F1dGhTZWNyZXRBcm4gPSBvYXV0aFByb3ZpZGVyLmdldEF0dFN0cmluZygnU2VjcmV0QXJuJyk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gRGVmYXVsdCBQb2xpY3kgb24gR2F0ZXdheSBSb2xlIChzY29wZWQgdG8gT0F1dGggcHJvdmlkZXIgcmVzb3VyY2VzKVxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIGdhdGV3YXlSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFJlc291cmNlT2F1dGgyVG9rZW4nLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRXb3JrbG9hZEFjY2Vzc1Rva2VuJyxcclxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxyXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW29hdXRoUHJvdmlkZXJBcm4sIG9hdXRoU2VjcmV0QXJuXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBHYXRld2F5IChBV1NfSUFNIGF1dGgg4oCUIE1haW4gUnVudGltZSBjYWxscyB2aWEgSW52b2tlR2F0ZXdheSBBUEkpXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgY29uc3QgZ2F0ZXdheSA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ01jcEdhdGV3YXknLCB7XHJcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXknLFxyXG4gICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgTmFtZTogJ2Zpbm9wcy1nYXRld2F5JyxcclxuICAgICAgICBEZXNjcmlwdGlvbjogJ0Zpbk9wcyBHYXRld2F5IGZvciBiaWxsaW5nIGFuZCBwcmljaW5nIE1DUCB0b29scyAoSUFNIGF1dGgpJyxcclxuICAgICAgICBQcm90b2NvbFR5cGU6ICdNQ1AnLFxyXG4gICAgICAgIEF1dGhvcml6ZXJUeXBlOiAnQVdTX0lBTScsXHJcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBNY3A6IHtcclxuICAgICAgICAgICAgSW5zdHJ1Y3Rpb25zOiAnRmluT3BzIGdhdGV3YXkgZm9yIGJpbGxpbmcgYW5kIHByaWNpbmcgTUNQIHRvb2xzJyxcclxuICAgICAgICAgICAgU2VhcmNoVHlwZTogJ1NFTUFOVElDJyxcclxuICAgICAgICAgICAgU3VwcG9ydGVkVmVyc2lvbnM6IFsnMjAyNS0wMy0yNiddLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIFJvbGVBcm46IGdhdGV3YXlSb2xlLnJvbGVBcm4sXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KG9hdXRoUHJvdmlkZXIpO1xyXG5cclxuICAgIHRoaXMuZ2F0ZXdheUFybiA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5QXJuJykudG9TdHJpbmcoKTtcclxuICAgIGNvbnN0IGdhdGV3YXlJZCA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5SWRlbnRpZmllcicpLnRvU3RyaW5nKCk7XHJcbiAgICB0aGlzLmdhdGV3YXlVcmwgPSBnYXRld2F5LmdldEF0dCgnR2F0ZXdheVVybCcpLnRvU3RyaW5nKCk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gR2F0ZXdheSBUYXJnZXRzIChNQ1AgU2VydmVyIGVuZHBvaW50cylcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBjb25zdCBiaWxsaW5nVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ01jcFRhcmdldCcsIHtcclxuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBHYXRld2F5SWRlbnRpZmllcjogZ2F0ZXdheUlkLFxyXG4gICAgICAgIE5hbWU6ICdiaWxsaW5nTWNwJyxcclxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIEJpbGxpbmcgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXHJcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xyXG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJDb25maWd1cmF0aW9uczogW3tcclxuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXHJcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcclxuICAgICAgICAgICAgT2F1dGhDcmVkZW50aWFsUHJvdmlkZXI6IHtcclxuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcclxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9XSxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgYmlsbGluZ1RhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XHJcblxyXG4gICAgY29uc3QgcHJpY2luZ1RhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdNY3BUYXJnZXQnLCB7XHJcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlUYXJnZXQnLFxyXG4gICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcclxuICAgICAgICBOYW1lOiAncHJpY2luZ01jcCcsXHJcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBQcmljaW5nIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxyXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcclxuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLnByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQgfSB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XHJcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJUeXBlOiAnT0FVVEgnLFxyXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XHJcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XHJcbiAgICAgICAgICAgICAgUHJvdmlkZXJBcm46IG9hdXRoUHJvdmlkZXJBcm4sXHJcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfV0sXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHByaWNpbmdUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIE91dHB1dHNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnR2F0ZXdheUFybicsIHtcclxuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheUFybixcclxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgR2F0ZXdheSBBUk4nLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR2F0ZXdheUFybmAsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnR2F0ZXdheVVybCcsIHtcclxuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheVVybCxcclxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgR2F0ZXdheSBVUkwnLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR2F0ZXdheVVybGAsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhnYXRld2F5Um9sZSwgW1xyXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBmb3IgQWdlbnRDb3JlIElkZW50aXR5IHRva2VuIGV4Y2hhbmdlIGFuZCBPQXV0aCBwcm92aWRlciBtYW5hZ2VtZW50LicgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhvYXV0aFByb3ZpZGVyRm4sIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgcmVxdWlyZWQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiB2YXVsdCBjcmVhdGlvbiBhbmQgYmVkcm9jay1hZ2VudGNvcmUtaWRlbnRpdHkgc2VjcmV0cyBuYW1lc3BhY2UuJyB9LFxyXG4gICAgXSwgdHJ1ZSk7XHJcblxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JywgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIEFXUyBiZXN0IHByYWN0aWNlLicsIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10gfSxcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiBleGNoYW5nZSwgT0F1dGggY3JlZGVudGlhbCBwcm92aWRlciBtYW5hZ2VtZW50LicsIGFwcGxpZXNUbzogWydSZXNvdXJjZTo6KiddIH0sXHJcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdMYW1iZGEgcnVudGltZSB2ZXJzaW9uIG1hbmFnZWQgYnkgQ0RLLicgfSxcclxuICAgIF0pO1xyXG4gIH1cclxufVxyXG4iXX0=