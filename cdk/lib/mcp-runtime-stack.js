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
exports.MCPRuntimeStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
class MCPRuntimeStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ========================================
        // IAM Roles for MCP Runtimes
        // ========================================
        // Billing MCP Server Runtime Role
        const billingMcpRuntimeRole = new iam.Role(this, 'BillingMcpRuntimeRole', {
            roleName: `${this.stackName}-BillingMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Pricing MCP Server Runtime Role
        const pricingMcpRuntimeRole = new iam.Role(this, 'PricingMcpRuntimeRole', {
            roleName: `${this.stackName}-PricingMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Common AgentCore Runtime permissions (ECR, CloudWatch, X-Ray, Bedrock, Gateway)
        const commonRuntimePermissions = [
            // ECR token access
            new iam.PolicyStatement({
                sid: 'ECRTokenAccess',
                effect: iam.Effect.ALLOW,
                actions: ['ecr:GetAuthorizationToken'],
                resources: ['*'],
            }),
            // CloudWatch Logs
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:DescribeLogGroups'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
            }),
            // Gateway invocation
            new iam.PolicyStatement({
                sid: 'AllowGatewayInvocation',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock-agentcore:InvokeGateway'],
                resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
            }),
        ];
        // Add common permissions to both roles
        for (const stmt of commonRuntimePermissions) {
            billingMcpRuntimeRole.addToPolicy(stmt);
            pricingMcpRuntimeRole.addToPolicy(stmt);
        }
        // ECR image pull for each role's specific repository
        props.billingMcpRepository.grantPull(billingMcpRuntimeRole);
        props.pricingMcpRepository.grantPull(pricingMcpRuntimeRole);
        // Add Cost Explorer and billing permissions to Billing MCP Runtime
        billingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ce:*',
                'budgets:*',
                'compute-optimizer:*',
                'freetier:*',
                'cost-optimization-hub:*',
                'pricing:GetProducts',
                'pricing:GetAttributeValues',
                'pricing:DescribeServices',
                'pricing:ListPriceListFiles',
                'pricing:GetPriceListFileUrl',
                'ec2:DescribeInstances',
                'ec2:DescribeVolumes',
                'ec2:DescribeInstanceTypes',
                'ec2:DescribeRegions',
                'autoscaling:DescribeAutoScalingGroups',
                'lambda:ListFunctions',
                'lambda:GetFunction',
                'ecs:ListClusters',
                'ecs:ListServices',
                'ecs:DescribeServices',
            ],
            resources: ['*'],
        }));
        // Add Pricing API permissions to Pricing MCP Runtime
        pricingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'pricing:GetProducts',
                'pricing:GetAttributeValues',
                'pricing:DescribeServices',
                'pricing:ListPriceListFiles',
                'pricing:GetPriceListFileUrl',
            ],
            resources: ['*'],
        }));
        // ========================================
        // MCP Runtimes with JWT Authorization
        // Gateway sends OAuth Bearer tokens, Runtimes validate JWT
        // ========================================
        // Billing MCP Server Runtime
        const cfnBillingMcpRuntime = new cdk.CfnResource(this, 'BillingMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'finops_billing_mcp_jwt_v1',
                Description: 'AWS Labs Billing MCP Server Runtime with JWT authorization',
                RoleArn: billingMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.billingMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnBillingMcpRuntime.node.addDependency(billingMcpRuntimeRole);
        this.billingMcpRuntimeArn = cfnBillingMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
        const encodedBillingArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.billingMcpRuntimeArn)))),
        ]);
        this.billingMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedBillingArn}/invocations?qualifier=DEFAULT`;
        // Pricing MCP Server Runtime
        const cfnPricingMcpRuntime = new cdk.CfnResource(this, 'PricingMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'finops_pricing_mcp_jwt_v1',
                Description: 'AWS Labs Pricing MCP Server Runtime with JWT authorization',
                RoleArn: pricingMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.pricingMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnPricingMcpRuntime.node.addDependency(pricingMcpRuntimeRole);
        this.pricingMcpRuntimeArn = cfnPricingMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
        const encodedPricingArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.pricingMcpRuntimeArn)))),
        ]);
        this.pricingMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedPricingArn}/invocations?qualifier=DEFAULT`;
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'BillingMcpRuntimeArn', {
            value: this.billingMcpRuntimeArn,
            description: 'Billing MCP Server Runtime ARN',
            exportName: `${this.stackName}-BillingMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'BillingMcpRuntimeEndpoint', {
            value: this.billingMcpRuntimeEndpoint,
            description: 'Billing MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-BillingMcpRuntimeEndpoint`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRuntimeArn', {
            value: this.pricingMcpRuntimeArn,
            description: 'Pricing MCP Server Runtime ARN',
            exportName: `${this.stackName}-PricingMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRuntimeEndpoint', {
            value: this.pricingMcpRuntimeEndpoint,
            description: 'Pricing MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-PricingMcpRuntimeEndpoint`,
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(billingMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for Cost Explorer APIs (account-level services), ECR auth token, CloudWatch, X-Ray',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(pricingMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for AWS Pricing API (global service), ECR auth token, CloudWatch, X-Ray',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-L1',
                reason: 'Python 3.14 is the latest Lambda runtime version available',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions',
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for custom resource Lambda functions',
            },
        ]);
    }
}
exports.MCPRuntimeStack = MCPRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJ1bnRpbWUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3AtcnVudGltZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBRzNDLHFDQUEwQztBQVUxQyxNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFNNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEyQjtRQUNuRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QiwyQ0FBMkM7UUFDM0MsNkJBQTZCO1FBQzdCLDJDQUEyQztRQUUzQyxrQ0FBa0M7UUFDbEMsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQ3hFLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLHdCQUF3QjtZQUNuRCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsaUNBQWlDLENBQUM7U0FDdkUsQ0FBQyxDQUFDO1FBRUgsa0NBQWtDO1FBQ2xDLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUN4RSxRQUFRLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyx3QkFBd0I7WUFDbkQsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDO1NBQ3ZFLENBQUMsQ0FBQztRQUVILGtGQUFrRjtRQUNsRixNQUFNLHdCQUF3QixHQUEwQjtZQUN0RCxtQkFBbUI7WUFDbkIsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO2dCQUN0QixHQUFHLEVBQUUsZ0JBQWdCO2dCQUNyQixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO2dCQUN4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LFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLDRCQUE0QjtTQUMxRCxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsdUJBQXVCO1FBQ3ZCLDJDQUEyQztRQUUzQyx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLHFCQUFxQixFQUFFO1lBQzdEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxrSEFBa0g7YUFDM0g7U0FDRixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxxQkFBcUIsRUFBRTtZQUM3RDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsdUdBQXVHO2FBQ2hIO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFO1lBQ3pDO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0REFBNEQ7YUFDckU7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0ZBQXNGO2FBQy9GO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLG9FQUFvRTthQUM3RTtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXhSRCwwQ0F3UkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xyXG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XHJcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcclxuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XHJcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBNQ1BSdW50aW1lU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcclxuICBiaWxsaW5nTWNwUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xyXG4gIHByaWNpbmdNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XHJcbiAgLy8gRnJvbSBBdXRoU3RhY2sgLSBmb3IgSldUIGF1dGhvcml6YXRpb24gb24gcnVudGltZXNcclxuICB1c2VyUG9vbElkOiBzdHJpbmc7XHJcbiAgbTJtQ2xpZW50SWQ6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIE1DUFJ1bnRpbWVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XHJcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XHJcbiAgcHVibGljIHJlYWRvbmx5IHByaWNpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XHJcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcclxuICBwdWJsaWMgcmVhZG9ubHkgcHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xyXG5cclxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogTUNQUnVudGltZVN0YWNrUHJvcHMpIHtcclxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIElBTSBSb2xlcyBmb3IgTUNQIFJ1bnRpbWVzXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgLy8gQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWUgUm9sZVxyXG4gICAgY29uc3QgYmlsbGluZ01jcFJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdCaWxsaW5nTWNwUnVudGltZVJvbGUnLCB7XHJcbiAgICAgIHJvbGVOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQmlsbGluZ01jcFJ1bnRpbWVSb2xlYCxcclxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lIFJvbGVcclxuICAgIGNvbnN0IHByaWNpbmdNY3BSdW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnUHJpY2luZ01jcFJ1bnRpbWVSb2xlJywge1xyXG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lUm9sZWAsXHJcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBDb21tb24gQWdlbnRDb3JlIFJ1bnRpbWUgcGVybWlzc2lvbnMgKEVDUiwgQ2xvdWRXYXRjaCwgWC1SYXksIEJlZHJvY2ssIEdhdGV3YXkpXHJcbiAgICBjb25zdCBjb21tb25SdW50aW1lUGVybWlzc2lvbnM6IGlhbS5Qb2xpY3lTdGF0ZW1lbnRbXSA9IFtcclxuICAgICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xyXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgc2lkOiAnRUNSVG9rZW5BY2Nlc3MnLFxyXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcclxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICB9KSxcclxuICAgICAgLy8gQ2xvdWRXYXRjaCBMb2dzXHJcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgYWN0aW9uczogWydsb2dzOkRlc2NyaWJlTG9nR3JvdXBzJ10sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOipgXSxcclxuICAgICAgfSksXHJcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgYWN0aW9uczogWydsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsICdsb2dzOkNyZWF0ZUxvZ0dyb3VwJ10sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmBdLFxyXG4gICAgICB9KSxcclxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKjpsb2ctc3RyZWFtOipgXSxcclxuICAgICAgfSksXHJcbiAgICAgIC8vIEdhdGV3YXkgaW52b2NhdGlvblxyXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgc2lkOiAnQWxsb3dHYXRld2F5SW52b2NhdGlvbicsXHJcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgIGFjdGlvbnM6IFsnYmVkcm9jay1hZ2VudGNvcmU6SW52b2tlR2F0ZXdheSddLFxyXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpnYXRld2F5LypgXSxcclxuICAgICAgfSksXHJcbiAgICBdO1xyXG5cclxuICAgIC8vIEFkZCBjb21tb24gcGVybWlzc2lvbnMgdG8gYm90aCByb2xlc1xyXG4gICAgZm9yIChjb25zdCBzdG10IG9mIGNvbW1vblJ1bnRpbWVQZXJtaXNzaW9ucykge1xyXG4gICAgICBiaWxsaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3koc3RtdCk7XHJcbiAgICAgIHByaWNpbmdNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShzdG10KTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBFQ1IgaW1hZ2UgcHVsbCBmb3IgZWFjaCByb2xlJ3Mgc3BlY2lmaWMgcmVwb3NpdG9yeVxyXG4gICAgcHJvcHMuYmlsbGluZ01jcFJlcG9zaXRvcnkuZ3JhbnRQdWxsKGJpbGxpbmdNY3BSdW50aW1lUm9sZSk7XHJcbiAgICBwcm9wcy5wcmljaW5nTWNwUmVwb3NpdG9yeS5ncmFudFB1bGwocHJpY2luZ01jcFJ1bnRpbWVSb2xlKTtcclxuXHJcbiAgICAvLyBBZGQgQ29zdCBFeHBsb3JlciBhbmQgYmlsbGluZyBwZXJtaXNzaW9ucyB0byBCaWxsaW5nIE1DUCBSdW50aW1lXHJcbiAgICBiaWxsaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnY2U6KicsXHJcbiAgICAgICAgJ2J1ZGdldHM6KicsXHJcbiAgICAgICAgJ2NvbXB1dGUtb3B0aW1pemVyOionLFxyXG4gICAgICAgICdmcmVldGllcjoqJyxcclxuICAgICAgICAnY29zdC1vcHRpbWl6YXRpb24taHViOionLFxyXG4gICAgICAgICdwcmljaW5nOkdldFByb2R1Y3RzJyxcclxuICAgICAgICAncHJpY2luZzpHZXRBdHRyaWJ1dGVWYWx1ZXMnLFxyXG4gICAgICAgICdwcmljaW5nOkRlc2NyaWJlU2VydmljZXMnLFxyXG4gICAgICAgICdwcmljaW5nOkxpc3RQcmljZUxpc3RGaWxlcycsXHJcbiAgICAgICAgJ3ByaWNpbmc6R2V0UHJpY2VMaXN0RmlsZVVybCcsXHJcbiAgICAgICAgJ2VjMjpEZXNjcmliZUluc3RhbmNlcycsXHJcbiAgICAgICAgJ2VjMjpEZXNjcmliZVZvbHVtZXMnLFxyXG4gICAgICAgICdlYzI6RGVzY3JpYmVJbnN0YW5jZVR5cGVzJyxcclxuICAgICAgICAnZWMyOkRlc2NyaWJlUmVnaW9ucycsXHJcbiAgICAgICAgJ2F1dG9zY2FsaW5nOkRlc2NyaWJlQXV0b1NjYWxpbmdHcm91cHMnLFxyXG4gICAgICAgICdsYW1iZGE6TGlzdEZ1bmN0aW9ucycsXHJcbiAgICAgICAgJ2xhbWJkYTpHZXRGdW5jdGlvbicsXHJcbiAgICAgICAgJ2VjczpMaXN0Q2x1c3RlcnMnLFxyXG4gICAgICAgICdlY3M6TGlzdFNlcnZpY2VzJyxcclxuICAgICAgICAnZWNzOkRlc2NyaWJlU2VydmljZXMnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vIEFkZCBQcmljaW5nIEFQSSBwZXJtaXNzaW9ucyB0byBQcmljaW5nIE1DUCBSdW50aW1lXHJcbiAgICBwcmljaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAncHJpY2luZzpHZXRQcm9kdWN0cycsXHJcbiAgICAgICAgJ3ByaWNpbmc6R2V0QXR0cmlidXRlVmFsdWVzJyxcclxuICAgICAgICAncHJpY2luZzpEZXNjcmliZVNlcnZpY2VzJyxcclxuICAgICAgICAncHJpY2luZzpMaXN0UHJpY2VMaXN0RmlsZXMnLFxyXG4gICAgICAgICdwcmljaW5nOkdldFByaWNlTGlzdEZpbGVVcmwnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIE1DUCBSdW50aW1lcyB3aXRoIEpXVCBBdXRob3JpemF0aW9uXHJcbiAgICAvLyBHYXRld2F5IHNlbmRzIE9BdXRoIEJlYXJlciB0b2tlbnMsIFJ1bnRpbWVzIHZhbGlkYXRlIEpXVFxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIC8vIEJpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lXHJcbiAgICBjb25zdCBjZm5CaWxsaW5nTWNwUnVudGltZSA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0JpbGxpbmdNY3BSdW50aW1lJywge1xyXG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJyxcclxuICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgIEFnZW50UnVudGltZU5hbWU6ICdmaW5vcHNfYmlsbGluZ19tY3Bfand0X3YxJyxcclxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIEJpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lIHdpdGggSldUIGF1dGhvcml6YXRpb24nLFxyXG4gICAgICAgIFJvbGVBcm46IGJpbGxpbmdNY3BSdW50aW1lUm9sZS5yb2xlQXJuLFxyXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XHJcbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMubTJtQ2xpZW50SWRdLFxyXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSxcclxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xyXG4gICAgICAgICAgQ29udGFpbmVyQ29uZmlndXJhdGlvbjoge1xyXG4gICAgICAgICAgICBDb250YWluZXJVcmk6IGAke3Byb3BzLmJpbGxpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGBcclxuICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIE5ldHdvcmtDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBOZXR3b3JrTW9kZTogJ1BVQkxJQydcclxuICAgICAgICB9LFxyXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiB7XHJcbiAgICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcclxuICAgICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgICAgfSxcclxuICAgICAgICBQcm90b2NvbENvbmZpZ3VyYXRpb246ICdNQ1AnLFxyXG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHt9LFxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIFxyXG4gICAgY2ZuQmlsbGluZ01jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KGJpbGxpbmdNY3BSdW50aW1lUm9sZSk7XHJcblxyXG4gICAgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybiA9IGNmbkJpbGxpbmdNY3BSdW50aW1lLmdldEF0dCgnQWdlbnRSdW50aW1lQXJuJykudG9TdHJpbmcoKTtcclxuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcclxuICAgIC8vIEZvcm1hdDogaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzL3tFTkNPREVEX0FSTn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRcclxuICAgIC8vIFRoZSBBUk4gbXVzdCBiZSBVUkwtZW5jb2RlZCAoOiDihpIgJTNBLCAvIOKGkiAlMkYpXHJcbiAgICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrLWFnZW50Y29yZS9sYXRlc3QvZGV2Z3VpZGUvcnVudGltZS1tY3AuaHRtbFxyXG4gICAgY29uc3QgZW5jb2RlZEJpbGxpbmdBcm4gPSBjZGsuRm4uam9pbignJywgW1xyXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4pKSxcclxuICAgICAgJyUzQScsXHJcbiAgICAgIGNkay5Gbi5zZWxlY3QoMSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxyXG4gICAgICAnJTNBJyxcclxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuKSksXHJcbiAgICAgICclM0EnLFxyXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4pKSxcclxuICAgICAgJyUzQScsXHJcbiAgICAgIGNkay5Gbi5zZWxlY3QoNCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxyXG4gICAgICAnJTNBJyxcclxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpKSksXHJcbiAgICBdKTtcclxuICAgIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCA9IGBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMvJHtlbmNvZGVkQmlsbGluZ0Fybn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRgO1xyXG5cclxuICAgIC8vIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lXHJcbiAgICBjb25zdCBjZm5QcmljaW5nTWNwUnVudGltZSA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdNY3BSdW50aW1lJywge1xyXG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJyxcclxuICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgIEFnZW50UnVudGltZU5hbWU6ICdmaW5vcHNfcHJpY2luZ19tY3Bfand0X3YxJyxcclxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lIHdpdGggSldUIGF1dGhvcml6YXRpb24nLFxyXG4gICAgICAgIFJvbGVBcm46IHByaWNpbmdNY3BSdW50aW1lUm9sZS5yb2xlQXJuLFxyXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XHJcbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMubTJtQ2xpZW50SWRdLFxyXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSxcclxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xyXG4gICAgICAgICAgQ29udGFpbmVyQ29uZmlndXJhdGlvbjoge1xyXG4gICAgICAgICAgICBDb250YWluZXJVcmk6IGAke3Byb3BzLnByaWNpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGBcclxuICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIE5ldHdvcmtDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBOZXR3b3JrTW9kZTogJ1BVQkxJQydcclxuICAgICAgICB9LFxyXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiB7XHJcbiAgICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcclxuICAgICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgICAgfSxcclxuICAgICAgICBQcm90b2NvbENvbmZpZ3VyYXRpb246ICdNQ1AnLFxyXG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHt9LFxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIFxyXG4gICAgY2ZuUHJpY2luZ01jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KHByaWNpbmdNY3BSdW50aW1lUm9sZSk7XHJcblxyXG4gICAgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybiA9IGNmblByaWNpbmdNY3BSdW50aW1lLmdldEF0dCgnQWdlbnRSdW50aW1lQXJuJykudG9TdHJpbmcoKTtcclxuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcclxuICAgIC8vIEZvcm1hdDogaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzL3tFTkNPREVEX0FSTn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRcclxuICAgIC8vIFRoZSBBUk4gbXVzdCBiZSBVUkwtZW5jb2RlZCAoOiDihpIgJTNBLCAvIOKGkiAlMkYpXHJcbiAgICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrLWFnZW50Y29yZS9sYXRlc3QvZGV2Z3VpZGUvcnVudGltZS1tY3AuaHRtbFxyXG4gICAgY29uc3QgZW5jb2RlZFByaWNpbmdBcm4gPSBjZGsuRm4uam9pbignJywgW1xyXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4pKSxcclxuICAgICAgJyUzQScsXHJcbiAgICAgIGNkay5Gbi5zZWxlY3QoMSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxyXG4gICAgICAnJTNBJyxcclxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuKSksXHJcbiAgICAgICclM0EnLFxyXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4pKSxcclxuICAgICAgJyUzQScsXHJcbiAgICAgIGNkay5Gbi5zZWxlY3QoNCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxyXG4gICAgICAnJTNBJyxcclxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpKSksXHJcbiAgICBdKTtcclxuICAgIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludCA9IGBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMvJHtlbmNvZGVkUHJpY2luZ0Fybn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRgO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIE91dHB1dHNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVBcm4nLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0JpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lIEFSTicsXHJcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUFybmAsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCcsIHtcclxuICAgICAgdmFsdWU6IHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCxcclxuICAgICAgZGVzY3JpcHRpb246ICdCaWxsaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSBFbmRwb2ludCcsXHJcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUVuZHBvaW50YCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUFybicsIHtcclxuICAgICAgdmFsdWU6IHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4sXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpY2luZyBNQ1AgU2VydmVyIFJ1bnRpbWUgQVJOJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lQXJuYCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUVuZHBvaW50Jywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5wcmljaW5nTWNwUnVudGltZUVuZHBvaW50LFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1ByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lIEVuZHBvaW50JyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoYmlsbGluZ01jcFJ1bnRpbWVSb2xlLCBbXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcclxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgQ29zdCBFeHBsb3JlciBBUElzIChhY2NvdW50LWxldmVsIHNlcnZpY2VzKSwgRUNSIGF1dGggdG9rZW4sIENsb3VkV2F0Y2gsIFgtUmF5JyxcclxuICAgICAgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwcmljaW5nTWNwUnVudGltZVJvbGUsIFtcclxuICAgICAge1xyXG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxyXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBBV1MgUHJpY2luZyBBUEkgKGdsb2JhbCBzZXJ2aWNlKSwgRUNSIGF1dGggdG9rZW4sIENsb3VkV2F0Y2gsIFgtUmF5JyxcclxuICAgICAgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXHJcbiAgICAgICAgcmVhc29uOiAnUHl0aG9uIDMuMTQgaXMgdGhlIGxhdGVzdCBMYW1iZGEgcnVudGltZSB2ZXJzaW9uIGF2YWlsYWJsZScsXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcclxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXHJcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIGN1c3RvbSByZXNvdXJjZSBMYW1iZGEgZnVuY3Rpb25zJyxcclxuICAgICAgfSxcclxuICAgIF0pO1xyXG4gIH1cclxufVxyXG4iXX0=