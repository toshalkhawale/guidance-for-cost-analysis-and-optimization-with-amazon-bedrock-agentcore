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
exports.AgentRuntimeStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const agentcore = __importStar(require("@aws-cdk/aws-bedrock-agentcore-alpha"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
class AgentRuntimeStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const foundationModel = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
        // ========================================
        // IAM Roles
        // ========================================
        // Main Runtime Role
        const runtimeRole = new iam.Role(this, 'RuntimeRole', {
            roleName: `${this.stackName}-RuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // ECR token access
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ECRTokenAccess',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));
        // CloudWatch Logs
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogGroups'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
        }));
        // Add Bedrock model permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:ConverseStream',
                'bedrock:Converse',
            ],
            resources: [
                `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
                `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/${foundationModel}`,
            ],
        }));
        // Add Memory permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:GetLastKTurns',
                'bedrock-agentcore:GetMemory',
                'bedrock-agentcore:ListEvents',
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`,
            ],
        }));
        // Add Gateway invocation permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:InvokeGateway',
                'bedrock-agentcore:GetGateway',
                'bedrock-agentcore:ListGatewayTargets',
            ],
            resources: [
                props.gatewayArn,
                `${props.gatewayArn}/*`, // For gateway targets
            ],
        }));
        // ========================================
        // Memory
        // ========================================
        const memory = new agentcore.Memory(this, 'FinOpsMemory', {
            memoryName: 'finops_memory',
            description: 'Memory for FinOps agent conversations',
            expirationDuration: cdk.Duration.days(30),
        });
        this.memoryId = memory.memoryId;
        // ========================================
        // Main Agent Runtime
        // ========================================
        const runtime = new agentcore.Runtime(this, 'FinOpsRuntime', {
            runtimeName: 'finops_runtime',
            description: 'FinOps Agent Runtime with Gateway integration',
            executionRole: runtimeRole,
            agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(props.repository, 'latest'),
            networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
            environmentVariables: {
                MEMORY_ID: memory.memoryId,
                MODEL_ID: foundationModel,
                AWS_REGION: this.region,
                GATEWAY_ARN: props.gatewayArn,
                DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                FORCE_REBUILD: `${Date.now()}`,
            },
        });
        // Grant ECR pull permissions (fromEcrRepository doesn't auto-grant)
        props.repository.grantPull(runtimeRole);
        this.mainRuntimeArn = runtime.agentRuntimeArn;
        this.mainRuntimeRole = runtimeRole;
        this.mainRuntimeRoleArn = runtimeRole.roleArn;
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'AgentCoreArn', {
            value: this.mainRuntimeArn,
            description: 'AgentCore Runtime ARN',
            exportName: `${this.stackName}-AgentCoreArn`,
        });
        new cdk.CfnOutput(this, 'MemoryId', {
            value: this.memoryId,
            description: 'Memory ID',
            exportName: `${this.stackName}-MemoryId`,
        });
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: props.userPoolId,
            description: 'Cognito User Pool ID',
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: props.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });
        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: props.identityPoolId,
            description: 'Cognito Identity Pool ID',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(runtimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for ECR auth token, CloudWatch Logs, Bedrock model invocation, and AgentCore memory access',
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
exports.AgentRuntimeStack = AgentRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBWTFDLE1BQWEsaUJBQWtCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFNOUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE2QjtRQUNyRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLGVBQWUsR0FBRyw4Q0FBOEMsQ0FBQztRQUV2RSwyQ0FBMkM7UUFDM0MsWUFBWTtRQUNaLDJDQUEyQztRQUUzQyxvQkFBb0I7UUFDcEIsTUFBTSxXQUFXLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDcEQsUUFBUSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsY0FBYztZQUN6QyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsaUNBQWlDLENBQUM7U0FDdkUsQ0FBQyxDQUFDO1FBRUgsbUJBQW1CO1FBQ25CLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzlDLEdBQUcsRUFBRSxnQkFBZ0I7WUFDckIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUUsQ0FBQywyQkFBMkIsQ0FBQztZQUN0QyxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7U0FDakIsQ0FBQyxDQUFDLENBQUM7UUFFSixrQkFBa0I7UUFDbEIsV0FBVyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDOUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFN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QTdMRCw4Q0E2TEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xyXG5pbXBvcnQgKiBhcyBhZ2VudGNvcmUgZnJvbSAnQGF3cy1jZGsvYXdzLWJlZHJvY2stYWdlbnRjb3JlLWFscGhhJztcclxuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xyXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XHJcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xyXG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRSdW50aW1lU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcclxuICByZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XHJcbiAgdXNlclBvb2xBcm46IHN0cmluZztcclxuICBnYXRld2F5QXJuOiBzdHJpbmc7IC8vIEdhdGV3YXkgQVJOIGZyb20gQWdlbnRDb3JlR2F0ZXdheVN0YWNrXHJcbiAgLy8gRm9yIGZyb250ZW5kIGNvbmZpZ3VyYXRpb24gb3V0cHV0c1xyXG4gIHVzZXJQb29sSWQ6IHN0cmluZztcclxuICB1c2VyUG9vbENsaWVudElkOiBzdHJpbmc7XHJcbiAgaWRlbnRpdHlQb29sSWQ6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEFnZW50UnVudGltZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcclxuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVBcm46IHN0cmluZztcclxuICBwdWJsaWMgcmVhZG9ubHkgbWVtb3J5SWQ6IHN0cmluZztcclxuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVSb2xlOiBpYW0uSVJvbGU7XHJcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lUm9sZUFybjogc3RyaW5nO1xyXG5cclxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQWdlbnRSdW50aW1lU3RhY2tQcm9wcykge1xyXG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XHJcblxyXG4gICAgY29uc3QgZm91bmRhdGlvbk1vZGVsID0gJ3VzLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNS0yMDI1MDkyOS12MTowJztcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBJQU0gUm9sZXNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICAvLyBNYWluIFJ1bnRpbWUgUm9sZVxyXG4gICAgY29uc3QgcnVudGltZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1J1bnRpbWVSb2xlJywge1xyXG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJ1bnRpbWVSb2xlYCxcclxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEVDUiB0b2tlbiBhY2Nlc3NcclxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgc2lkOiAnRUNSVG9rZW5BY2Nlc3MnLFxyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLFxyXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vIENsb3VkV2F0Y2ggTG9nc1xyXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ0dyb3VwcyddLFxyXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6KmBdLFxyXG4gICAgfSkpO1xyXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLCAnbG9nczpDcmVhdGVMb2dHcm91cCddLFxyXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qYF0sXHJcbiAgICB9KSk7XHJcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogWydsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsICdsb2dzOlB1dExvZ0V2ZW50cyddLFxyXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qOmxvZy1zdHJlYW06KmBdLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vIEFkZCBCZWRyb2NrIG1vZGVsIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxyXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbCcsXHJcbiAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWxXaXRoUmVzcG9uc2VTdHJlYW0nLFxyXG4gICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJyxcclxuICAgICAgICAnYmVkcm9jazpDb252ZXJzZScsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8ke2ZvdW5kYXRpb25Nb2RlbH1gLFxyXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTUtMjAyNTA5MjktdjE6MGAsXHJcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2ZvdW5kYXRpb25Nb2RlbH1gLFxyXG4gICAgICBdLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vIEFkZCBNZW1vcnkgcGVybWlzc2lvbnMgdG8gTWFpbiBSdW50aW1lXHJcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVFdmVudCcsXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldExhc3RLVHVybnMnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRNZW1vcnknLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0RXZlbnRzJyxcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9Om1lbW9yeS8qYCxcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBBZGQgR2F0ZXdheSBpbnZvY2F0aW9uIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxyXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6SW52b2tlR2F0ZXdheScsXHJcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0R2F0ZXdheVRhcmdldHMnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICBwcm9wcy5nYXRld2F5QXJuLFxyXG4gICAgICAgIGAke3Byb3BzLmdhdGV3YXlBcm59LypgLCAvLyBGb3IgZ2F0ZXdheSB0YXJnZXRzXHJcbiAgICAgIF0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gTWVtb3J5XHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgY29uc3QgbWVtb3J5ID0gbmV3IGFnZW50Y29yZS5NZW1vcnkodGhpcywgJ0Zpbk9wc01lbW9yeScsIHtcclxuICAgICAgbWVtb3J5TmFtZTogJ2Zpbm9wc19tZW1vcnknLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ01lbW9yeSBmb3IgRmluT3BzIGFnZW50IGNvbnZlcnNhdGlvbnMnLFxyXG4gICAgICBleHBpcmF0aW9uRHVyYXRpb246IGNkay5EdXJhdGlvbi5kYXlzKDMwKSxcclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMubWVtb3J5SWQgPSBtZW1vcnkubWVtb3J5SWQ7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4gICAgY29uc3QgcnVudGltZSA9IG5ldyBhZ2VudGNvcmUuUnVudGltZSh0aGlzLCAnRmluT3BzUnVudGltZScsIHtcclxuICAgICAgcnVudGltZU5hbWU6ICdmaW5vcHNfcnVudGltZScsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnRmluT3BzIEFnZW50IFJ1bnRpbWUgd2l0aCBHYXRld2F5IGludGVncmF0aW9uJyxcclxuICAgICAgZXhlY3V0aW9uUm9sZTogcnVudGltZVJvbGUsXHJcbiAgICAgIGFnZW50UnVudGltZUFydGlmYWN0OiBhZ2VudGNvcmUuQWdlbnRSdW50aW1lQXJ0aWZhY3QuZnJvbUVjclJlcG9zaXRvcnkoXHJcbiAgICAgICAgcHJvcHMucmVwb3NpdG9yeSxcclxuICAgICAgICAnbGF0ZXN0J1xyXG4gICAgICApLFxyXG4gICAgICBuZXR3b3JrQ29uZmlndXJhdGlvbjogYWdlbnRjb3JlLlJ1bnRpbWVOZXR3b3JrQ29uZmlndXJhdGlvbi51c2luZ1B1YmxpY05ldHdvcmsoKSxcclxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICBNRU1PUllfSUQ6IG1lbW9yeS5tZW1vcnlJZCxcclxuICAgICAgICBNT0RFTF9JRDogZm91bmRhdGlvbk1vZGVsLFxyXG4gICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxyXG4gICAgICAgIEdBVEVXQVlfQVJOOiBwcm9wcy5nYXRld2F5QXJuLFxyXG4gICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgICAgRk9SQ0VfUkVCVUlMRDogYCR7RGF0ZS5ub3coKX1gLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gR3JhbnQgRUNSIHB1bGwgcGVybWlzc2lvbnMgKGZyb21FY3JSZXBvc2l0b3J5IGRvZXNuJ3QgYXV0by1ncmFudClcclxuICAgIHByb3BzLnJlcG9zaXRvcnkuZ3JhbnRQdWxsKHJ1bnRpbWVSb2xlKTtcclxuXHJcbiAgICB0aGlzLm1haW5SdW50aW1lQXJuID0gcnVudGltZS5hZ2VudFJ1bnRpbWVBcm47XHJcbiAgICB0aGlzLm1haW5SdW50aW1lUm9sZSA9IHJ1bnRpbWVSb2xlO1xyXG4gICAgdGhpcy5tYWluUnVudGltZVJvbGVBcm4gPSBydW50aW1lUm9sZS5yb2xlQXJuO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIE91dHB1dHNcclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWdlbnRDb3JlQXJuJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5tYWluUnVudGltZUFybixcclxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgUnVudGltZSBBUk4nLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWdlbnRDb3JlQXJuYCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNZW1vcnlJZCcsIHtcclxuICAgICAgdmFsdWU6IHRoaXMubWVtb3J5SWQsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnTWVtb3J5IElEJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1lbW9yeUlkYCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xyXG4gICAgICB2YWx1ZTogcHJvcHMudXNlclBvb2xJZCxcclxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcclxuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJZGVudGl0eVBvb2xJZCcsIHtcclxuICAgICAgdmFsdWU6IHByb3BzLmlkZW50aXR5UG9vbElkLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gSWRlbnRpdHkgUG9vbCBJRCcsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhydW50aW1lUm9sZSwgW1xyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXHJcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIEVDUiBhdXRoIHRva2VuLCBDbG91ZFdhdGNoIExvZ3MsIEJlZHJvY2sgbW9kZWwgaW52b2NhdGlvbiwgYW5kIEFnZW50Q29yZSBtZW1vcnkgYWNjZXNzJyxcclxuICAgICAgfSxcclxuICAgIF0sIHRydWUpO1xyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXHJcbiAgICAgICAgcmVhc29uOiAnUHl0aG9uIDMuMTQgaXMgdGhlIGxhdGVzdCBMYW1iZGEgcnVudGltZSB2ZXJzaW9uIGF2YWlsYWJsZScsXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcclxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXHJcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIGN1c3RvbSByZXNvdXJjZSBMYW1iZGEgZnVuY3Rpb25zJyxcclxuICAgICAgfSxcclxuICAgIF0pO1xyXG4gIH1cclxufVxyXG4iXX0=