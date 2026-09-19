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
exports.AuthStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
class AuthStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ========================================
        // Cognito User Pool
        // ========================================
        const userPool = new cognito.UserPool(this, 'FinOpsUserPool', {
            userPoolName: `${this.stackName}-users`,
            selfSignUpEnabled: false,
            signInAliases: {
                email: true,
                username: true,
            },
            autoVerify: {
                email: true,
            },
            userInvitation: {
                emailSubject: 'Your FinOps Agent Login Credentials',
                emailBody: [
                    '<h2>Welcome to FinOps Agent</h2>',
                    '<p>Your admin account has been created. You will be prompted to change your password on first login.</p>',
                    '<br/>',
                    '<p><strong>Username</strong></p>',
                    '<p style="font-family: monospace; font-size: 16px; background: #f0f0f0; padding: 8px; display: inline-block;">{username}</p>',
                    '<br/>',
                    '<p><strong>Temporary Password</strong></p>',
                    '<p style="font-family: monospace; font-size: 16px; background: #f0f0f0; padding: 8px; display: inline-block;">{####}</p>',
                ].join('\n'),
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true, // Add symbol requirement for stronger security
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.userPoolId = userPool.userPoolId;
        this.userPoolArn = userPool.userPoolArn;
        this.userPoolProviderName = userPool.userPoolProviderName;
        // Add Cognito Domain for OAuth
        const userPoolDomain = userPool.addDomain('FinOpsDomain', {
            cognitoDomain: {
                domainPrefix: `finops-mcp-${this.account}-${cdk.Names.uniqueId(this).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8)}`,
            },
        });
        // OAuth endpoints for Gateway and AgentCore Identity
        const domainUrl = `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;
        this.oauthTokenEndpoint = `${domainUrl}/oauth2/token`;
        this.oauthAuthorizationEndpoint = `${domainUrl}/oauth2/authorize`;
        this.oauthIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
        // ========================================
        // User Pool Clients
        // ========================================
        // Create Resource Server for M2M authentication (required for client_credentials flow)
        const mcpInvokeScope = {
            scopeName: 'invoke',
            scopeDescription: 'Invoke MCP runtime tools',
        };
        const resourceServer = userPool.addResourceServer('FinOpsResourceServer', {
            identifier: 'mcp-runtime-server',
            userPoolResourceServerName: `${this.stackName}-resource-server`,
            scopes: [mcpInvokeScope],
        });
        // Client for frontend users (no secret)
        const userPoolClient = userPool.addClient('FinOpsUserPoolClient', {
            userPoolClientName: `${this.stackName}-client`,
            generateSecret: false,
            authFlows: {
                userPassword: true,
                userSrp: true,
                custom: true,
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
            },
        });
        this.userPoolClientId = userPoolClient.userPoolClientId;
        // M2M Client for Gateway → MCP Server Runtimes (with secret for client credentials flow)
        const m2mClient = userPool.addClient('FinOpsM2MClient', {
            userPoolClientName: `${this.stackName}-m2m-client`,
            generateSecret: true,
            authFlows: {
                userPassword: false,
                userSrp: false,
                custom: false,
            },
            oAuth: {
                flows: {
                    clientCredentials: true, // M2M flow
                },
                scopes: [
                    cognito.OAuthScope.resourceServer(resourceServer, mcpInvokeScope),
                ],
            },
        });
        this.oauthClientId = m2mClient.userPoolClientId;
        // ========================================
        // Identity Pool
        // ========================================
        const identityPool = new cognito.CfnIdentityPool(this, 'FinOpsIdentityPool', {
            identityPoolName: `${this.stackName.replace(/[^a-zA-Z0-9]/g, '_')}_identity_pool`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [
                {
                    clientId: userPoolClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
                {
                    clientId: m2mClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
            ],
        });
        this.identityPoolId = identityPool.ref;
        // ========================================
        // IAM Roles for Identity Pool
        // ========================================
        // Authenticated Role - Can invoke Main Agent Runtime
        const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
            roleName: `${this.stackName}-authenticated-role`,
            assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
                StringEquals: {
                    'cognito-identity.amazonaws.com:aud': identityPool.ref,
                },
                'ForAnyValue:StringLike': {
                    'cognito-identity.amazonaws.com:amr': 'authenticated',
                },
            }, 'sts:AssumeRoleWithWebIdentity'),
        });
        // Note: Runtime ARN will be added after AgentStack is deployed
        // Frontend users will invoke the main agent runtime via IAM
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:InvokeAgentRuntime',
                'bedrock-agentcore:GetRuntime',
                'bedrock-agentcore:ListRuntimes',
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/finops_billing_mcp*`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/finops_pricing_mcp*`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/finops_runtime*`,
            ],
        }));
        // Unauthenticated Role - Deny all
        const unauthenticatedRole = new iam.Role(this, 'UnauthenticatedRole', {
            roleName: `${this.stackName}-unauthenticated-role`,
            assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
                StringEquals: {
                    'cognito-identity.amazonaws.com:aud': identityPool.ref,
                },
                'ForAnyValue:StringLike': {
                    'cognito-identity.amazonaws.com:amr': 'unauthenticated',
                },
            }, 'sts:AssumeRoleWithWebIdentity'),
        });
        unauthenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['*'],
            resources: ['*'],
        }));
        // Attach roles to Identity Pool
        new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
            identityPoolId: identityPool.ref,
            roles: {
                authenticated: authenticatedRole.roleArn,
                unauthenticated: unauthenticatedRole.roleArn,
            },
        });
        // ========================================
        // Admin User
        // ========================================
        new cognito.CfnUserPoolUser(this, 'AdminUser', {
            userPoolId: userPool.userPoolId,
            username: 'admin',
            userAttributes: [
                {
                    name: 'email',
                    value: props.adminEmail,
                },
                {
                    name: 'email_verified',
                    value: 'true',
                },
            ],
            desiredDeliveryMediums: ['EMAIL'],
        });
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.userPoolId,
            description: 'Cognito User Pool ID',
            exportName: `${this.stackName}-UserPoolId`,
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: this.userPoolClientId,
            description: 'Cognito User Pool Client ID',
            exportName: `${this.stackName}-UserPoolClientId`,
        });
        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: this.identityPoolId,
            description: 'Cognito Identity Pool ID',
            exportName: `${this.stackName}-IdentityPoolId`,
        });
        new cdk.CfnOutput(this, 'UserPoolArn', {
            value: this.userPoolArn,
            description: 'Cognito User Pool ARN',
            exportName: `${this.stackName}-UserPoolArn`,
        });
        new cdk.CfnOutput(this, 'OAuthClientId', {
            value: this.oauthClientId,
            description: 'OAuth Client ID for Gateway',
            exportName: `${this.stackName}-OAuthClientId`,
        });
        new cdk.CfnOutput(this, 'OAuthTokenEndpoint', {
            value: this.oauthTokenEndpoint,
            description: 'OAuth Token Endpoint for Gateway',
            exportName: `${this.stackName}-OAuthTokenEndpoint`,
        });
        new cdk.CfnOutput(this, 'OAuthAuthorizationEndpoint', {
            value: this.oauthAuthorizationEndpoint,
            description: 'OAuth Authorization Endpoint',
            exportName: `${this.stackName}-OAuthAuthorizationEndpoint`,
        });
        new cdk.CfnOutput(this, 'OAuthIssuer', {
            value: this.oauthIssuer,
            description: 'OAuth Issuer URL',
            exportName: `${this.stackName}-OAuthIssuer`,
        });
        new cdk.CfnOutput(this, 'OAuthDiscoveryUrl', {
            value: `${this.oauthIssuer}/.well-known/openid-configuration`,
            description: 'OAuth Discovery URL for M2M authentication',
            exportName: `${this.stackName}-OAuthDiscoveryUrl`,
        });
        new cdk.CfnOutput(this, 'AuthenticatedRoleArn', {
            value: authenticatedRole.roleArn,
            description: 'Authenticated Role ARN',
        });
        new cdk.CfnOutput(this, 'AdminEmail', {
            value: props.adminEmail,
            description: 'Admin user email (temporary password sent via email)',
        });
        new cdk.CfnOutput(this, 'AdminUsername', {
            value: 'admin',
            description: 'Admin username',
        });
        // ========================================
        // OAuth Provider - Created by external Python script after stack deploy
        // ========================================
        this.oauthProviderName = 'finops-mcp-oauth-provider';
        this.oauthProviderArn = 'CREATED_BY_SCRIPT'; // Will be read from oauth-provider-arn.txt
        new cdk.CfnOutput(this, 'OAuthProviderName', {
            value: this.oauthProviderName,
            description: 'OAuth Provider Name (created by scripts/create-oauth-provider.py)',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        // Cognito User Pool suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(userPool, [
            {
                id: 'AwsSolutions-COG2',
                reason: 'MFA not enforced for demo/development environment. Production deployments should enable MFA for enhanced security.',
            },
            {
                id: 'AwsSolutions-COG3',
                reason: 'Advanced security features (compromised credentials check) not required for demo/development environment. Production deployments should enable AdvancedSecurityMode.',
            },
        ], true);
        // Authenticated Role suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(authenticatedRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard required for AgentCore runtime invocation to support all session IDs and conversation turns (runtime ARN with /* suffix)',
            },
        ], true);
        // Stack-level suppressions for CDK-created Lambda functions (Cognito domain custom resource)
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions created by CDK for Cognito domain custom resource',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            },
            {
                id: 'AwsSolutions-L1',
                reason: 'Lambda function is created and managed by CDK for Cognito domain custom resource - runtime is automatically updated by CDK',
            },
        ]);
    }
}
exports.AuthStack = AuthStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImF1dGgtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCx5REFBMkM7QUFHM0MscUNBQTBDO0FBTTFDLE1BQWEsU0FBVSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBYXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBcUI7UUFDN0QsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLG9CQUFvQjtRQUNwQiwyQ0FBMkM7UUFFM0MsTUFBTSxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUM1RCxZQUFZLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxRQUFRO1lBQ3ZDLGlCQUFpQixFQUFFLEtBQUs7WUFDeEIsYUFBYSxFQUFFO2dCQUNiLEtBQUssRUFBRSxJQUFJO2dCQUNYLFFBQVEsRUFBRSxJQUFJO2FBQ2Y7WUFDRCxVQUFVLEVBQUU7Z0JBQ1YsS0FBSyxFQUFFLElBQUk7YUFDWjtZQUNELGNBQWMsRUFBRTtnQkFDZCxZQUFZLEVBQUUscUNBQXFDO2dCQUNuRCxTQUFTLEVBQUU7b0JBQ1Qsa0NBQWtDO29CQUNsQywwR0FBMEc7b0JBQzFHLE9BQU87b0JBQ1Asa0NBQWtDO29CQUNsQyw4SEFBOEg7b0JBQzlILE9BQU87b0JBQ1AsNENBQTRDO29CQUM1QywwSEFBMEg7aUJBQzNILENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQzthQUNiO1lBQ0QsY0FBYyxFQUFFO2dCQUNkLFNBQVMsRUFBRSxDQUFDO2dCQUNaLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLGFBQWEsRUFBRSxJQUFJO2dCQUNuQixj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QUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMzQyxLQUFLLEVBQUUsSUFBSSxDQUFDLGlCQUFpQjtZQUM3QixXQUFXLEVBQUUsbUVBQW1FO1NBQ2pGLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQyx1QkFBdUI7UUFDdkIsMkNBQTJDO1FBRTNDLGlDQUFpQztRQUNqQyx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLFFBQVEsRUFBRTtZQUNoRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsb0hBQW9IO2FBQzdIO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHNLQUFzSzthQUMvSztTQUNGLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCxrQ0FBa0M7UUFDbEMseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRTtZQUN6RDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsbUlBQW1JO2FBQzVJO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUlULDZGQUE2RjtRQUM3Rix5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QztnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsd0lBQXdJO2dCQUNoSixTQUFTLEVBQUUsQ0FBQyx1RkFBdUYsQ0FBQzthQUNyRztZQUNEO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0SEFBNEg7YUFDckk7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE5V0QsOEJBOFdDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XHJcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcclxuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xyXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcclxuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xyXG4gIGFkbWluRW1haWw6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEF1dGhTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XHJcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sSWQ6IHN0cmluZztcclxuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBpZGVudGl0eVBvb2xJZDogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbEFybjogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbFByb3ZpZGVyTmFtZTogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBvYXV0aENsaWVudElkOiBzdHJpbmc7XHJcbiAgcHVibGljIHJlYWRvbmx5IG9hdXRoVG9rZW5FbmRwb2ludDogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBvYXV0aEF1dGhvcml6YXRpb25FbmRwb2ludDogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBvYXV0aElzc3Vlcjogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBvYXV0aFByb3ZpZGVyTmFtZTogc3RyaW5nO1xyXG4gIHB1YmxpYyByZWFkb25seSBvYXV0aFByb3ZpZGVyQXJuOiBzdHJpbmc7XHJcblxyXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBdXRoU3RhY2tQcm9wcykge1xyXG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gQ29nbml0byBVc2VyIFBvb2xcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBjb25zdCB1c2VyUG9vbCA9IG5ldyBjb2duaXRvLlVzZXJQb29sKHRoaXMsICdGaW5PcHNVc2VyUG9vbCcsIHtcclxuICAgICAgdXNlclBvb2xOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tdXNlcnNgLFxyXG4gICAgICBzZWxmU2lnblVwRW5hYmxlZDogZmFsc2UsXHJcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHtcclxuICAgICAgICBlbWFpbDogdHJ1ZSxcclxuICAgICAgICB1c2VybmFtZTogdHJ1ZSxcclxuICAgICAgfSxcclxuICAgICAgYXV0b1ZlcmlmeToge1xyXG4gICAgICAgIGVtYWlsOiB0cnVlLFxyXG4gICAgICB9LFxyXG4gICAgICB1c2VySW52aXRhdGlvbjoge1xyXG4gICAgICAgIGVtYWlsU3ViamVjdDogJ1lvdXIgRmluT3BzIEFnZW50IExvZ2luIENyZWRlbnRpYWxzJyxcclxuICAgICAgICBlbWFpbEJvZHk6IFtcclxuICAgICAgICAgICc8aDI+V2VsY29tZSB0byBGaW5PcHMgQWdlbnQ8L2gyPicsXHJcbiAgICAgICAgICAnPHA+WW91ciBhZG1pbiBhY2NvdW50IGhhcyBiZWVuIGNyZWF0ZWQuIFlvdSB3aWxsIGJlIHByb21wdGVkIHRvIGNoYW5nZSB5b3VyIHBhc3N3b3JkIG9uIGZpcnN0IGxvZ2luLjwvcD4nLFxyXG4gICAgICAgICAgJzxici8+JyxcclxuICAgICAgICAgICc8cD48c3Ryb25nPlVzZXJuYW1lPC9zdHJvbmc+PC9wPicsXHJcbiAgICAgICAgICAnPHAgc3R5bGU9XCJmb250LWZhbWlseTogbW9ub3NwYWNlOyBmb250LXNpemU6IDE2cHg7IGJhY2tncm91bmQ6ICNmMGYwZjA7IHBhZGRpbmc6IDhweDsgZGlzcGxheTogaW5saW5lLWJsb2NrO1wiPnt1c2VybmFtZX08L3A+JyxcclxuICAgICAgICAgICc8YnIvPicsXHJcbiAgICAgICAgICAnPHA+PHN0cm9uZz5UZW1wb3JhcnkgUGFzc3dvcmQ8L3N0cm9uZz48L3A+JyxcclxuICAgICAgICAgICc8cCBzdHlsZT1cImZvbnQtZmFtaWx5OiBtb25vc3BhY2U7IGZvbnQtc2l6ZTogMTZweDsgYmFja2dyb3VuZDogI2YwZjBmMDsgcGFkZGluZzogOHB4OyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7XCI+eyMjIyN9PC9wPicsXHJcbiAgICAgICAgXS5qb2luKCdcXG4nKSxcclxuICAgICAgfSxcclxuICAgICAgcGFzc3dvcmRQb2xpY3k6IHtcclxuICAgICAgICBtaW5MZW5ndGg6IDgsXHJcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcclxuICAgICAgICByZXF1aXJlVXBwZXJjYXNlOiB0cnVlLFxyXG4gICAgICAgIHJlcXVpcmVEaWdpdHM6IHRydWUsXHJcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsIC8vIEFkZCBzeW1ib2wgcmVxdWlyZW1lbnQgZm9yIHN0cm9uZ2VyIHNlY3VyaXR5XHJcbiAgICAgIH0sXHJcbiAgICAgIGFjY291bnRSZWNvdmVyeTogY29nbml0by5BY2NvdW50UmVjb3ZlcnkuRU1BSUxfT05MWSxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMudXNlclBvb2xJZCA9IHVzZXJQb29sLnVzZXJQb29sSWQ7XHJcbiAgICB0aGlzLnVzZXJQb29sQXJuID0gdXNlclBvb2wudXNlclBvb2xBcm47XHJcbiAgICB0aGlzLnVzZXJQb29sUHJvdmlkZXJOYW1lID0gdXNlclBvb2wudXNlclBvb2xQcm92aWRlck5hbWU7XHJcblxyXG4gICAgLy8gQWRkIENvZ25pdG8gRG9tYWluIGZvciBPQXV0aFxyXG4gICAgY29uc3QgdXNlclBvb2xEb21haW4gPSB1c2VyUG9vbC5hZGREb21haW4oJ0Zpbk9wc0RvbWFpbicsIHtcclxuICAgICAgY29nbml0b0RvbWFpbjoge1xyXG4gICAgICAgIGRvbWFpblByZWZpeDogYGZpbm9wcy1tY3AtJHt0aGlzLmFjY291bnR9LSR7Y2RrLk5hbWVzLnVuaXF1ZUlkKHRoaXMpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTldL2csICcnKS5zdWJzdHJpbmcoMCwgOCl9YCxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIE9BdXRoIGVuZHBvaW50cyBmb3IgR2F0ZXdheSBhbmQgQWdlbnRDb3JlIElkZW50aXR5XHJcbiAgICBjb25zdCBkb21haW5VcmwgPSBgaHR0cHM6Ly8ke3VzZXJQb29sRG9tYWluLmRvbWFpbk5hbWV9LmF1dGguJHt0aGlzLnJlZ2lvbn0uYW1hem9uY29nbml0by5jb21gO1xyXG4gICAgdGhpcy5vYXV0aFRva2VuRW5kcG9pbnQgPSBgJHtkb21haW5Vcmx9L29hdXRoMi90b2tlbmA7XHJcbiAgICB0aGlzLm9hdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50ID0gYCR7ZG9tYWluVXJsfS9vYXV0aDIvYXV0aG9yaXplYDtcclxuICAgIHRoaXMub2F1dGhJc3N1ZXIgPSBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7dXNlclBvb2wudXNlclBvb2xJZH1gO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIFVzZXIgUG9vbCBDbGllbnRzXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgLy8gQ3JlYXRlIFJlc291cmNlIFNlcnZlciBmb3IgTTJNIGF1dGhlbnRpY2F0aW9uIChyZXF1aXJlZCBmb3IgY2xpZW50X2NyZWRlbnRpYWxzIGZsb3cpXHJcbiAgICBjb25zdCBtY3BJbnZva2VTY29wZTogY29nbml0by5SZXNvdXJjZVNlcnZlclNjb3BlID0ge1xyXG4gICAgICBzY29wZU5hbWU6ICdpbnZva2UnLFxyXG4gICAgICBzY29wZURlc2NyaXB0aW9uOiAnSW52b2tlIE1DUCBydW50aW1lIHRvb2xzJyxcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVzb3VyY2VTZXJ2ZXIgPSB1c2VyUG9vbC5hZGRSZXNvdXJjZVNlcnZlcignRmluT3BzUmVzb3VyY2VTZXJ2ZXInLCB7XHJcbiAgICAgIGlkZW50aWZpZXI6ICdtY3AtcnVudGltZS1zZXJ2ZXInLFxyXG4gICAgICB1c2VyUG9vbFJlc291cmNlU2VydmVyTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXJlc291cmNlLXNlcnZlcmAsXHJcbiAgICAgIHNjb3BlczogW21jcEludm9rZVNjb3BlXSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIENsaWVudCBmb3IgZnJvbnRlbmQgdXNlcnMgKG5vIHNlY3JldClcclxuICAgIGNvbnN0IHVzZXJQb29sQ2xpZW50ID0gdXNlclBvb2wuYWRkQ2xpZW50KCdGaW5PcHNVc2VyUG9vbENsaWVudCcsIHtcclxuICAgICAgdXNlclBvb2xDbGllbnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tY2xpZW50YCxcclxuICAgICAgZ2VuZXJhdGVTZWNyZXQ6IGZhbHNlLFxyXG4gICAgICBhdXRoRmxvd3M6IHtcclxuICAgICAgICB1c2VyUGFzc3dvcmQ6IHRydWUsXHJcbiAgICAgICAgdXNlclNycDogdHJ1ZSxcclxuICAgICAgICBjdXN0b206IHRydWUsXHJcbiAgICAgIH0sXHJcbiAgICAgIG9BdXRoOiB7XHJcbiAgICAgICAgZmxvd3M6IHtcclxuICAgICAgICAgIGF1dGhvcml6YXRpb25Db2RlR3JhbnQ6IHRydWUsXHJcbiAgICAgICAgICBpbXBsaWNpdENvZGVHcmFudDogdHJ1ZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNjb3BlczogW1xyXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLkVNQUlMLFxyXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLk9QRU5JRCxcclxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5QUk9GSUxFLFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLnVzZXJQb29sQ2xpZW50SWQgPSB1c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkO1xyXG5cclxuICAgIC8vIE0yTSBDbGllbnQgZm9yIEdhdGV3YXkg4oaSIE1DUCBTZXJ2ZXIgUnVudGltZXMgKHdpdGggc2VjcmV0IGZvciBjbGllbnQgY3JlZGVudGlhbHMgZmxvdylcclxuICAgIGNvbnN0IG0ybUNsaWVudCA9IHVzZXJQb29sLmFkZENsaWVudCgnRmluT3BzTTJNQ2xpZW50Jywge1xyXG4gICAgICB1c2VyUG9vbENsaWVudE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1tMm0tY2xpZW50YCxcclxuICAgICAgZ2VuZXJhdGVTZWNyZXQ6IHRydWUsXHJcbiAgICAgIGF1dGhGbG93czoge1xyXG4gICAgICAgIHVzZXJQYXNzd29yZDogZmFsc2UsXHJcbiAgICAgICAgdXNlclNycDogZmFsc2UsXHJcbiAgICAgICAgY3VzdG9tOiBmYWxzZSxcclxuICAgICAgfSxcclxuICAgICAgb0F1dGg6IHtcclxuICAgICAgICBmbG93czoge1xyXG4gICAgICAgICAgY2xpZW50Q3JlZGVudGlhbHM6IHRydWUsIC8vIE0yTSBmbG93XHJcbiAgICAgICAgfSxcclxuICAgICAgICBzY29wZXM6IFtcclxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5yZXNvdXJjZVNlcnZlcihyZXNvdXJjZVNlcnZlciwgbWNwSW52b2tlU2NvcGUpLFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLm9hdXRoQ2xpZW50SWQgPSBtMm1DbGllbnQudXNlclBvb2xDbGllbnRJZDtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBJZGVudGl0eSBQb29sXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgY29uc3QgaWRlbnRpdHlQb29sID0gbmV3IGNvZ25pdG8uQ2ZuSWRlbnRpdHlQb29sKHRoaXMsICdGaW5PcHNJZGVudGl0eVBvb2wnLCB7XHJcbiAgICAgIGlkZW50aXR5UG9vbE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lLnJlcGxhY2UoL1teYS16QS1aMC05XS9nLCAnXycpfV9pZGVudGl0eV9wb29sYCxcclxuICAgICAgYWxsb3dVbmF1dGhlbnRpY2F0ZWRJZGVudGl0aWVzOiBmYWxzZSxcclxuICAgICAgY29nbml0b0lkZW50aXR5UHJvdmlkZXJzOiBbXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgY2xpZW50SWQ6IHVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXHJcbiAgICAgICAgICBwcm92aWRlck5hbWU6IHVzZXJQb29sLnVzZXJQb29sUHJvdmlkZXJOYW1lLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgY2xpZW50SWQ6IG0ybUNsaWVudC51c2VyUG9vbENsaWVudElkLFxyXG4gICAgICAgICAgcHJvdmlkZXJOYW1lOiB1c2VyUG9vbC51c2VyUG9vbFByb3ZpZGVyTmFtZSxcclxuICAgICAgICB9LFxyXG4gICAgICBdLFxyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy5pZGVudGl0eVBvb2xJZCA9IGlkZW50aXR5UG9vbC5yZWY7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gSUFNIFJvbGVzIGZvciBJZGVudGl0eSBQb29sXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgLy8gQXV0aGVudGljYXRlZCBSb2xlIC0gQ2FuIGludm9rZSBNYWluIEFnZW50IFJ1bnRpbWVcclxuICAgIGNvbnN0IGF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdBdXRoZW50aWNhdGVkUm9sZScsIHtcclxuICAgICAgcm9sZU5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1hdXRoZW50aWNhdGVkLXJvbGVgLFxyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uRmVkZXJhdGVkUHJpbmNpcGFsKFxyXG4gICAgICAgICdjb2duaXRvLWlkZW50aXR5LmFtYXpvbmF3cy5jb20nLFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xyXG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmF1ZCc6IGlkZW50aXR5UG9vbC5yZWYsXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgJ0ZvckFueVZhbHVlOlN0cmluZ0xpa2UnOiB7XHJcbiAgICAgICAgICAgICdjb2duaXRvLWlkZW50aXR5LmFtYXpvbmF3cy5jb206YW1yJzogJ2F1dGhlbnRpY2F0ZWQnLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgICdzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eSdcclxuICAgICAgKSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIE5vdGU6IFJ1bnRpbWUgQVJOIHdpbGwgYmUgYWRkZWQgYWZ0ZXIgQWdlbnRTdGFjayBpcyBkZXBsb3llZFxyXG4gICAgLy8gRnJvbnRlbmQgdXNlcnMgd2lsbCBpbnZva2UgdGhlIG1haW4gYWdlbnQgcnVudGltZSB2aWEgSUFNXHJcbiAgICBhdXRoZW50aWNhdGVkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRSdW50aW1lJyxcclxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdFJ1bnRpbWVzJyxcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnJ1bnRpbWUvZmlub3BzX2JpbGxpbmdfbWNwKmAsXHJcbiAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnJ1bnRpbWUvZmlub3BzX3ByaWNpbmdfbWNwKmAsXHJcbiAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnJ1bnRpbWUvZmlub3BzX3J1bnRpbWUqYCxcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBVbmF1dGhlbnRpY2F0ZWQgUm9sZSAtIERlbnkgYWxsXHJcbiAgICBjb25zdCB1bmF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdVbmF1dGhlbnRpY2F0ZWRSb2xlJywge1xyXG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXVuYXV0aGVudGljYXRlZC1yb2xlYCxcclxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLkZlZGVyYXRlZFByaW5jaXBhbChcclxuICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tJyxcclxuICAgICAgICB7XHJcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcclxuICAgICAgICAgICAgJ2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphdWQnOiBpZGVudGl0eVBvb2wucmVmLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgICdGb3JBbnlWYWx1ZTpTdHJpbmdMaWtlJzoge1xyXG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmFtcic6ICd1bmF1dGhlbnRpY2F0ZWQnLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgICdzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eSdcclxuICAgICAgKSxcclxuICAgIH0pO1xyXG5cclxuICAgIHVuYXV0aGVudGljYXRlZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuREVOWSxcclxuICAgICAgYWN0aW9uczogWycqJ10sXHJcbiAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gQXR0YWNoIHJvbGVzIHRvIElkZW50aXR5IFBvb2xcclxuICAgIG5ldyBjb2duaXRvLkNmbklkZW50aXR5UG9vbFJvbGVBdHRhY2htZW50KHRoaXMsICdJZGVudGl0eVBvb2xSb2xlQXR0YWNobWVudCcsIHtcclxuICAgICAgaWRlbnRpdHlQb29sSWQ6IGlkZW50aXR5UG9vbC5yZWYsXHJcbiAgICAgIHJvbGVzOiB7XHJcbiAgICAgICAgYXV0aGVudGljYXRlZDogYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcclxuICAgICAgICB1bmF1dGhlbnRpY2F0ZWQ6IHVuYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIEFkbWluIFVzZXJcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBuZXcgY29nbml0by5DZm5Vc2VyUG9vbFVzZXIodGhpcywgJ0FkbWluVXNlcicsIHtcclxuICAgICAgdXNlclBvb2xJZDogdXNlclBvb2wudXNlclBvb2xJZCxcclxuICAgICAgdXNlcm5hbWU6ICdhZG1pbicsXHJcbiAgICAgIHVzZXJBdHRyaWJ1dGVzOiBbXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgbmFtZTogJ2VtYWlsJyxcclxuICAgICAgICAgIHZhbHVlOiBwcm9wcy5hZG1pbkVtYWlsLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgbmFtZTogJ2VtYWlsX3ZlcmlmaWVkJyxcclxuICAgICAgICAgIHZhbHVlOiAndHJ1ZScsXHJcbiAgICAgICAgfSxcclxuICAgICAgXSxcclxuICAgICAgZGVzaXJlZERlbGl2ZXJ5TWVkaXVtczogWydFTUFJTCddLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gT3V0cHV0c1xyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbElkLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVVzZXJQb29sSWRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQ2xpZW50SWQnLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sQ2xpZW50SWQsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVVzZXJQb29sQ2xpZW50SWRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0lkZW50aXR5UG9vbElkJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5pZGVudGl0eVBvb2xJZCxcclxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIElkZW50aXR5IFBvb2wgSUQnLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSWRlbnRpdHlQb29sSWRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQXJuJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbEFybixcclxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBBUk4nLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVXNlclBvb2xBcm5gLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoQ2xpZW50SWQnLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoQ2xpZW50SWQsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnT0F1dGggQ2xpZW50IElEIGZvciBHYXRld2F5JyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU9BdXRoQ2xpZW50SWRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoVG9rZW5FbmRwb2ludCcsIHtcclxuICAgICAgdmFsdWU6IHRoaXMub2F1dGhUb2tlbkVuZHBvaW50LFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIFRva2VuIEVuZHBvaW50IGZvciBHYXRld2F5JyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU9BdXRoVG9rZW5FbmRwb2ludGAsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnT0F1dGhBdXRob3JpemF0aW9uRW5kcG9pbnQnLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50LFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIEF1dGhvcml6YXRpb24gRW5kcG9pbnQnLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tT0F1dGhBdXRob3JpemF0aW9uRW5kcG9pbnRgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoSXNzdWVyJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5vYXV0aElzc3VlcixcclxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBJc3N1ZXIgVVJMJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU9BdXRoSXNzdWVyYCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aERpc2NvdmVyeVVybCcsIHtcclxuICAgICAgdmFsdWU6IGAke3RoaXMub2F1dGhJc3N1ZXJ9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcclxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBEaXNjb3ZlcnkgVVJMIGZvciBNMk0gYXV0aGVudGljYXRpb24nLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tT0F1dGhEaXNjb3ZlcnlVcmxgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0F1dGhlbnRpY2F0ZWRSb2xlQXJuJywge1xyXG4gICAgICB2YWx1ZTogYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcclxuICAgICAgZGVzY3JpcHRpb246ICdBdXRoZW50aWNhdGVkIFJvbGUgQVJOJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBZG1pbkVtYWlsJywge1xyXG4gICAgICB2YWx1ZTogcHJvcHMuYWRtaW5FbWFpbCxcclxuICAgICAgZGVzY3JpcHRpb246ICdBZG1pbiB1c2VyIGVtYWlsICh0ZW1wb3JhcnkgcGFzc3dvcmQgc2VudCB2aWEgZW1haWwpJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBZG1pblVzZXJuYW1lJywge1xyXG4gICAgICB2YWx1ZTogJ2FkbWluJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdBZG1pbiB1c2VybmFtZScsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBPQXV0aCBQcm92aWRlciAtIENyZWF0ZWQgYnkgZXh0ZXJuYWwgUHl0aG9uIHNjcmlwdCBhZnRlciBzdGFjayBkZXBsb3lcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICB0aGlzLm9hdXRoUHJvdmlkZXJOYW1lID0gJ2Zpbm9wcy1tY3Atb2F1dGgtcHJvdmlkZXInO1xyXG4gICAgdGhpcy5vYXV0aFByb3ZpZGVyQXJuID0gJ0NSRUFURURfQllfU0NSSVBUJzsgLy8gV2lsbCBiZSByZWFkIGZyb20gb2F1dGgtcHJvdmlkZXItYXJuLnR4dFxyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aFByb3ZpZGVyTmFtZScsIHtcclxuICAgICAgdmFsdWU6IHRoaXMub2F1dGhQcm92aWRlck5hbWUsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnT0F1dGggUHJvdmlkZXIgTmFtZSAoY3JlYXRlZCBieSBzY3JpcHRzL2NyZWF0ZS1vYXV0aC1wcm92aWRlci5weSknLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbCBzdXBwcmVzc2lvbnNcclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh1c2VyUG9vbCwgW1xyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ09HMicsXHJcbiAgICAgICAgcmVhc29uOiAnTUZBIG5vdCBlbmZvcmNlZCBmb3IgZGVtby9kZXZlbG9wbWVudCBlbnZpcm9ubWVudC4gUHJvZHVjdGlvbiBkZXBsb3ltZW50cyBzaG91bGQgZW5hYmxlIE1GQSBmb3IgZW5oYW5jZWQgc2VjdXJpdHkuJyxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUNPRzMnLFxyXG4gICAgICAgIHJlYXNvbjogJ0FkdmFuY2VkIHNlY3VyaXR5IGZlYXR1cmVzIChjb21wcm9taXNlZCBjcmVkZW50aWFscyBjaGVjaykgbm90IHJlcXVpcmVkIGZvciBkZW1vL2RldmVsb3BtZW50IGVudmlyb25tZW50LiBQcm9kdWN0aW9uIGRlcGxveW1lbnRzIHNob3VsZCBlbmFibGUgQWR2YW5jZWRTZWN1cml0eU1vZGUuJyxcclxuICAgICAgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuICAgIC8vIEF1dGhlbnRpY2F0ZWQgUm9sZSBzdXBwcmVzc2lvbnNcclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhhdXRoZW50aWNhdGVkUm9sZSwgW1xyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXHJcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcmVxdWlyZWQgZm9yIEFnZW50Q29yZSBydW50aW1lIGludm9jYXRpb24gdG8gc3VwcG9ydCBhbGwgc2Vzc2lvbiBJRHMgYW5kIGNvbnZlcnNhdGlvbiB0dXJucyAocnVudGltZSBBUk4gd2l0aCAvKiBzdWZmaXgpJyxcclxuICAgICAgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuXHJcblxyXG4gICAgLy8gU3RhY2stbGV2ZWwgc3VwcHJlc3Npb25zIGZvciBDREstY3JlYXRlZCBMYW1iZGEgZnVuY3Rpb25zIChDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UpXHJcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXHJcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciBMYW1iZGEgZnVuY3Rpb25zIGNyZWF0ZWQgYnkgQ0RLIGZvciBDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UnLFxyXG4gICAgICAgIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXHJcbiAgICAgICAgcmVhc29uOiAnTGFtYmRhIGZ1bmN0aW9uIGlzIGNyZWF0ZWQgYW5kIG1hbmFnZWQgYnkgQ0RLIGZvciBDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UgLSBydW50aW1lIGlzIGF1dG9tYXRpY2FsbHkgdXBkYXRlZCBieSBDREsnLFxyXG4gICAgICB9LFxyXG4gICAgXSk7XHJcbiAgfVxyXG59XHJcbiJdfQ==