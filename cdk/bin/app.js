#!/usr/bin/env node
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
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk_nag_1 = require("cdk-nag");
const image_stack_1 = require("../lib/image-stack");
const auth_stack_1 = require("../lib/auth-stack");
const mcp_runtime_stack_1 = require("../lib/mcp-runtime-stack");
const gateway_stack_1 = require("../lib/gateway-stack");
const agent_runtime_stack_1 = require("../lib/agent-runtime-stack");
const app = new cdk.App();
// Add CDK-Nag AWS Solutions checks
aws_cdk_lib_1.Aspects.of(app).add(new cdk_nag_1.AwsSolutionsChecks({ verbose: true }));
// Get configuration from context or environment
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};
const adminEmail = process.env.ADMIN_EMAIL || app.node.tryGetContext('adminEmail');
if (!adminEmail) {
    console.error('\n❌ ERROR: ADMIN_EMAIL environment variable is required.');
    console.error('Please set it before deploying:');
    console.error('  export ADMIN_EMAIL="your-email@example.com"');
    console.error('  cdk deploy\n');
    throw new Error('ADMIN_EMAIL environment variable is required. Set it before deploying.');
}
// ========================================
// Validated Deployment Sequence
// ========================================
// Stack 1: Image Stack - Builds Docker images for Agent Runtimes
const imageStack = new image_stack_1.ImageStack(app, 'FinOpsImageStack', {
    env,
    description: '(SO9696) FinOps Agent - Docker Image Build (ECR + CodeBuild)',
});
// Stack 2: Auth Stack - Cognito + M2M + OAuth Provider (Custom Resource)
const authStack = new auth_stack_1.AuthStack(app, 'FinOpsAuthStack', {
    env,
    description: 'FinOps Agent - Cognito Authentication + OAuth Provider',
    adminEmail: adminEmail,
});
// Stack 3: MCP Runtime Stack - Deploy 2 MCP Runtimes with JWT auth
const mcpRuntimeStack = new mcp_runtime_stack_1.MCPRuntimeStack(app, 'FinOpsMCPRuntimeStack', {
    env,
    description: 'FinOps Agent - MCP Server Runtimes (Billing + Pricing) with JWT Authorization',
    billingMcpRepository: imageStack.billingMcpRepository,
    pricingMcpRepository: imageStack.pricingMcpRepository,
    userPoolId: authStack.userPoolId,
    m2mClientId: authStack.oauthClientId,
});
mcpRuntimeStack.addDependency(imageStack);
mcpRuntimeStack.addDependency(authStack);
// Stack 4: AgentCore Gateway Stack - Gateway + its own Cognito + OAuth provider + MCP targets
const agentCoreGatewayStack = new gateway_stack_1.AgentCoreGatewayStack(app, 'FinOpsAgentCoreGatewayStack', {
    env,
    description: 'FinOps Agent - Gateway with MCP Server Targets',
    billingMcpRuntimeArn: mcpRuntimeStack.billingMcpRuntimeArn,
    pricingMcpRuntimeArn: mcpRuntimeStack.pricingMcpRuntimeArn,
    billingMcpRuntimeEndpoint: mcpRuntimeStack.billingMcpRuntimeEndpoint,
    pricingMcpRuntimeEndpoint: mcpRuntimeStack.pricingMcpRuntimeEndpoint,
    // AuthStack Cognito for outbound OAuth to runtimes
    authUserPoolId: authStack.userPoolId,
    authUserPoolArn: authStack.userPoolArn,
    authM2mClientId: authStack.oauthClientId,
});
agentCoreGatewayStack.addDependency(mcpRuntimeStack);
agentCoreGatewayStack.addDependency(authStack);
// Stack 5: Main Runtime Stack - Main agent runtime with Gateway ARN
const agentRuntimeStack = new agent_runtime_stack_1.AgentRuntimeStack(app, 'FinOpsAgentRuntimeStack', {
    env,
    description: 'FinOps Agent - Main Agent Runtime with Gateway Integration',
    repository: imageStack.repository,
    userPoolArn: authStack.userPoolArn,
    gatewayArn: agentCoreGatewayStack.gatewayArn,
    userPoolId: authStack.userPoolId,
    userPoolClientId: authStack.userPoolClientId,
    identityPoolId: authStack.identityPoolId,
});
agentRuntimeStack.addDependency(imageStack);
agentRuntimeStack.addDependency(authStack);
agentRuntimeStack.addDependency(agentCoreGatewayStack);
// Add tags to all stacks
cdk.Tags.of(app).add('Project', 'FinOpsAgent');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsNkNBQXNDO0FBQ3RDLHFDQUE2QztBQUM3QyxvREFBZ0Q7QUFDaEQsa0RBQThDO0FBQzlDLGdFQUEyRDtBQUMzRCx3REFBNkQ7QUFDN0Qsb0VBQStEO0FBRS9ELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLG1DQUFtQztBQUNuQyxxQkFBTyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSw0QkFBa0IsQ0FBQyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFFL0QsZ0RBQWdEO0FBQ2hELE1BQU0sR0FBRyxHQUFHO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO0lBQ3hDLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixJQUFJLFdBQVc7Q0FDdEQsQ0FBQztBQUVGLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBRW5GLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUNoQixPQUFPLENBQUMsS0FBSyxDQUFDLDBEQUEwRCxDQUFDLENBQUM7SUFDMUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDO0lBQ2pELE9BQU8sQ0FBQyxLQUFLLENBQUMsK0NBQStDLENBQUMsQ0FBQztJQUMvRCxPQUFPLENBQUMsS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUM7SUFDaEMsTUFBTSxJQUFJLEtBQUssQ0FBQyx3RUFBd0UsQ0FBQyxDQUFDO0FBQzVGLENBQUM7QUFFRCwyQ0FBMkM7QUFDM0MsZ0NBQWdDO0FBQ2hDLDJDQUEyQztBQUUzQyxpRUFBaUU7QUFDakUsTUFBTSxVQUFVLEdBQUcsSUFBSSx3QkFBVSxDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRTtJQUN6RCxHQUFHO0lBQ0gsV0FBVyxFQUFFLDhEQUE4RDtDQUM1RSxDQUFDLENBQUM7QUFFSCx5RUFBeUU7QUFDekUsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEdBQUcsRUFBRSxpQkFBaUIsRUFBRTtJQUN0RCxHQUFHO0lBQ0gsV0FBVyxFQUFFLHdEQUF3RDtJQUNyRSxVQUFVLEVBQUUsVUFBVTtDQUN2QixDQUFDLENBQUM7QUFFSCxtRUFBbUU7QUFDbkUsTUFBTSxlQUFlLEdBQUcsSUFBSSxtQ0FBZSxDQUFDLEdBQUcsRUFBRSx1QkFBdUIsRUFBRTtJQUN4RSxHQUFHO0lBQ0gsV0FBVyxFQUFFLCtFQUErRTtJQUM1RixvQkFBb0IsRUFBRSxVQUFVLENBQUMsb0JBQW9CO0lBQ3JELG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0I7SUFDckQsVUFBVSxFQUFFLFNBQVMsQ0FBQyxVQUFVO0lBQ2hDLFdBQVcsRUFBRSxTQUFTLENBQUMsYUFBYTtDQUNyQyxDQUFDLENBQUM7QUFDSCxlQUFlLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQzFDLGVBQWUsQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekMsOEZBQThGO0FBQzlGLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxxQ0FBcUIsQ0FBQyxHQUFHLEVBQUUsNkJBQTZCLEVBQUU7SUFDMUYsR0FBRztJQUNILFdBQVcsRUFBRSxnREFBZ0Q7SUFDN0Qsb0JBQW9CLEVBQUUsZUFBZSxDQUFDLG9CQUFvQjtJQUMxRCxvQkFBb0IsRUFBRSxlQUFlLENBQUMsb0JBQW9CO0lBQzFELHlCQUF5QixFQUFFLGVBQWUsQ0FBQyx5QkFBeUI7SUFDcEUseUJBQXlCLEVBQUUsZUFBZSxDQUFDLHlCQUF5QjtJQUNwRSxtREFBbUQ7SUFDbkQsY0FBYyxFQUFFLFNBQVMsQ0FBQyxVQUFVO0lBQ3BDLGVBQWUsRUFBRSxTQUFTLENBQUMsV0FBVztJQUN0QyxlQUFlLEVBQUUsU0FBUyxDQUFDLGFBQWE7Q0FDekMsQ0FBQyxDQUFDO0FBQ0gscUJBQXFCLENBQUMsYUFBYSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0FBQ3JELHFCQUFxQixDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUUvQyxvRUFBb0U7QUFDcEUsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLHVDQUFpQixDQUFDLEdBQUcsRUFBRSx5QkFBeUIsRUFBRTtJQUM5RSxHQUFHO0lBQ0gsV0FBVyxFQUFFLDREQUE0RDtJQUN6RSxVQUFVLEVBQUUsVUFBVSxDQUFDLFVBQVU7SUFDakMsV0FBVyxFQUFFLFNBQVMsQ0FBQyxXQUFXO0lBQ2xDLFVBQVUsRUFBRSxxQkFBcUIsQ0FBQyxVQUFVO0lBQzVDLFVBQVUsRUFBRSxTQUFTLENBQUMsVUFBVTtJQUNoQyxnQkFBZ0IsRUFBRSxTQUFTLENBQUMsZ0JBQWdCO0lBQzVDLGNBQWMsRUFBRSxTQUFTLENBQUMsY0FBYztDQUN6QyxDQUFDLENBQUM7QUFDSCxpQkFBaUIsQ0FBQyxhQUFhLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDNUMsaUJBQWlCLENBQUMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQzNDLGlCQUFpQixDQUFDLGFBQWEsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO0FBRXZELHlCQUF5QjtBQUN6QixHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLGFBQWEsQ0FBQyxDQUFDO0FBQy9DLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXHJcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQXNwZWN0cyB9IGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQXdzU29sdXRpb25zQ2hlY2tzIH0gZnJvbSAnY2RrLW5hZyc7XHJcbmltcG9ydCB7IEltYWdlU3RhY2sgfSBmcm9tICcuLi9saWIvaW1hZ2Utc3RhY2snO1xyXG5pbXBvcnQgeyBBdXRoU3RhY2sgfSBmcm9tICcuLi9saWIvYXV0aC1zdGFjayc7XHJcbmltcG9ydCB7IE1DUFJ1bnRpbWVTdGFjayB9IGZyb20gJy4uL2xpYi9tY3AtcnVudGltZS1zdGFjayc7XHJcbmltcG9ydCB7IEFnZW50Q29yZUdhdGV3YXlTdGFjayB9IGZyb20gJy4uL2xpYi9nYXRld2F5LXN0YWNrJztcclxuaW1wb3J0IHsgQWdlbnRSdW50aW1lU3RhY2sgfSBmcm9tICcuLi9saWIvYWdlbnQtcnVudGltZS1zdGFjayc7XHJcblxyXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xyXG5cclxuLy8gQWRkIENESy1OYWcgQVdTIFNvbHV0aW9ucyBjaGVja3NcclxuQXNwZWN0cy5vZihhcHApLmFkZChuZXcgQXdzU29sdXRpb25zQ2hlY2tzKHsgdmVyYm9zZTogdHJ1ZSB9KSk7XHJcblxyXG4vLyBHZXQgY29uZmlndXJhdGlvbiBmcm9tIGNvbnRleHQgb3IgZW52aXJvbm1lbnRcclxuY29uc3QgZW52ID0ge1xyXG4gIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXHJcbiAgcmVnaW9uOiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9SRUdJT04gfHwgJ3VzLWVhc3QtMScsXHJcbn07XHJcblxyXG5jb25zdCBhZG1pbkVtYWlsID0gcHJvY2Vzcy5lbnYuQURNSU5fRU1BSUwgfHwgYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnYWRtaW5FbWFpbCcpO1xyXG5cclxuaWYgKCFhZG1pbkVtYWlsKSB7XHJcbiAgY29uc29sZS5lcnJvcignXFxu4p2MIEVSUk9SOiBBRE1JTl9FTUFJTCBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyByZXF1aXJlZC4nKTtcclxuICBjb25zb2xlLmVycm9yKCdQbGVhc2Ugc2V0IGl0IGJlZm9yZSBkZXBsb3lpbmc6Jyk7XHJcbiAgY29uc29sZS5lcnJvcignICBleHBvcnQgQURNSU5fRU1BSUw9XCJ5b3VyLWVtYWlsQGV4YW1wbGUuY29tXCInKTtcclxuICBjb25zb2xlLmVycm9yKCcgIGNkayBkZXBsb3lcXG4nKTtcclxuICB0aHJvdyBuZXcgRXJyb3IoJ0FETUlOX0VNQUlMIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkLiBTZXQgaXQgYmVmb3JlIGRlcGxveWluZy4nKTtcclxufVxyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBWYWxpZGF0ZWQgRGVwbG95bWVudCBTZXF1ZW5jZVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vLyBTdGFjayAxOiBJbWFnZSBTdGFjayAtIEJ1aWxkcyBEb2NrZXIgaW1hZ2VzIGZvciBBZ2VudCBSdW50aW1lc1xyXG5jb25zdCBpbWFnZVN0YWNrID0gbmV3IEltYWdlU3RhY2soYXBwLCAnRmluT3BzSW1hZ2VTdGFjaycsIHtcclxuICBlbnYsXHJcbiAgZGVzY3JpcHRpb246ICcoU085Njk2KSBGaW5PcHMgQWdlbnQgLSBEb2NrZXIgSW1hZ2UgQnVpbGQgKEVDUiArIENvZGVCdWlsZCknLFxyXG59KTtcclxuXHJcbi8vIFN0YWNrIDI6IEF1dGggU3RhY2sgLSBDb2duaXRvICsgTTJNICsgT0F1dGggUHJvdmlkZXIgKEN1c3RvbSBSZXNvdXJjZSlcclxuY29uc3QgYXV0aFN0YWNrID0gbmV3IEF1dGhTdGFjayhhcHAsICdGaW5PcHNBdXRoU3RhY2snLCB7XHJcbiAgZW52LFxyXG4gIGRlc2NyaXB0aW9uOiAnRmluT3BzIEFnZW50IC0gQ29nbml0byBBdXRoZW50aWNhdGlvbiArIE9BdXRoIFByb3ZpZGVyJyxcclxuICBhZG1pbkVtYWlsOiBhZG1pbkVtYWlsLFxyXG59KTtcclxuXHJcbi8vIFN0YWNrIDM6IE1DUCBSdW50aW1lIFN0YWNrIC0gRGVwbG95IDIgTUNQIFJ1bnRpbWVzIHdpdGggSldUIGF1dGhcclxuY29uc3QgbWNwUnVudGltZVN0YWNrID0gbmV3IE1DUFJ1bnRpbWVTdGFjayhhcHAsICdGaW5PcHNNQ1BSdW50aW1lU3RhY2snLCB7XHJcbiAgZW52LFxyXG4gIGRlc2NyaXB0aW9uOiAnRmluT3BzIEFnZW50IC0gTUNQIFNlcnZlciBSdW50aW1lcyAoQmlsbGluZyArIFByaWNpbmcpIHdpdGggSldUIEF1dGhvcml6YXRpb24nLFxyXG4gIGJpbGxpbmdNY3BSZXBvc2l0b3J5OiBpbWFnZVN0YWNrLmJpbGxpbmdNY3BSZXBvc2l0b3J5LFxyXG4gIHByaWNpbmdNY3BSZXBvc2l0b3J5OiBpbWFnZVN0YWNrLnByaWNpbmdNY3BSZXBvc2l0b3J5LFxyXG4gIHVzZXJQb29sSWQ6IGF1dGhTdGFjay51c2VyUG9vbElkLFxyXG4gIG0ybUNsaWVudElkOiBhdXRoU3RhY2sub2F1dGhDbGllbnRJZCxcclxufSk7XHJcbm1jcFJ1bnRpbWVTdGFjay5hZGREZXBlbmRlbmN5KGltYWdlU3RhY2spO1xyXG5tY3BSdW50aW1lU3RhY2suYWRkRGVwZW5kZW5jeShhdXRoU3RhY2spO1xyXG5cclxuLy8gU3RhY2sgNDogQWdlbnRDb3JlIEdhdGV3YXkgU3RhY2sgLSBHYXRld2F5ICsgaXRzIG93biBDb2duaXRvICsgT0F1dGggcHJvdmlkZXIgKyBNQ1AgdGFyZ2V0c1xyXG5jb25zdCBhZ2VudENvcmVHYXRld2F5U3RhY2sgPSBuZXcgQWdlbnRDb3JlR2F0ZXdheVN0YWNrKGFwcCwgJ0Zpbk9wc0FnZW50Q29yZUdhdGV3YXlTdGFjaycsIHtcclxuICBlbnYsXHJcbiAgZGVzY3JpcHRpb246ICdGaW5PcHMgQWdlbnQgLSBHYXRld2F5IHdpdGggTUNQIFNlcnZlciBUYXJnZXRzJyxcclxuICBiaWxsaW5nTWNwUnVudGltZUFybjogbWNwUnVudGltZVN0YWNrLmJpbGxpbmdNY3BSdW50aW1lQXJuLFxyXG4gIHByaWNpbmdNY3BSdW50aW1lQXJuOiBtY3BSdW50aW1lU3RhY2sucHJpY2luZ01jcFJ1bnRpbWVBcm4sXHJcbiAgYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludDogbWNwUnVudGltZVN0YWNrLmJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQsXHJcbiAgcHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludDogbWNwUnVudGltZVN0YWNrLnByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQsXHJcbiAgLy8gQXV0aFN0YWNrIENvZ25pdG8gZm9yIG91dGJvdW5kIE9BdXRoIHRvIHJ1bnRpbWVzXHJcbiAgYXV0aFVzZXJQb29sSWQ6IGF1dGhTdGFjay51c2VyUG9vbElkLFxyXG4gIGF1dGhVc2VyUG9vbEFybjogYXV0aFN0YWNrLnVzZXJQb29sQXJuLFxyXG4gIGF1dGhNMm1DbGllbnRJZDogYXV0aFN0YWNrLm9hdXRoQ2xpZW50SWQsXHJcbn0pO1xyXG5hZ2VudENvcmVHYXRld2F5U3RhY2suYWRkRGVwZW5kZW5jeShtY3BSdW50aW1lU3RhY2spO1xyXG5hZ2VudENvcmVHYXRld2F5U3RhY2suYWRkRGVwZW5kZW5jeShhdXRoU3RhY2spO1xyXG5cclxuLy8gU3RhY2sgNTogTWFpbiBSdW50aW1lIFN0YWNrIC0gTWFpbiBhZ2VudCBydW50aW1lIHdpdGggR2F0ZXdheSBBUk5cclxuY29uc3QgYWdlbnRSdW50aW1lU3RhY2sgPSBuZXcgQWdlbnRSdW50aW1lU3RhY2soYXBwLCAnRmluT3BzQWdlbnRSdW50aW1lU3RhY2snLCB7XHJcbiAgZW52LFxyXG4gIGRlc2NyaXB0aW9uOiAnRmluT3BzIEFnZW50IC0gTWFpbiBBZ2VudCBSdW50aW1lIHdpdGggR2F0ZXdheSBJbnRlZ3JhdGlvbicsXHJcbiAgcmVwb3NpdG9yeTogaW1hZ2VTdGFjay5yZXBvc2l0b3J5LFxyXG4gIHVzZXJQb29sQXJuOiBhdXRoU3RhY2sudXNlclBvb2xBcm4sXHJcbiAgZ2F0ZXdheUFybjogYWdlbnRDb3JlR2F0ZXdheVN0YWNrLmdhdGV3YXlBcm4sXHJcbiAgdXNlclBvb2xJZDogYXV0aFN0YWNrLnVzZXJQb29sSWQsXHJcbiAgdXNlclBvb2xDbGllbnRJZDogYXV0aFN0YWNrLnVzZXJQb29sQ2xpZW50SWQsXHJcbiAgaWRlbnRpdHlQb29sSWQ6IGF1dGhTdGFjay5pZGVudGl0eVBvb2xJZCxcclxufSk7XHJcbmFnZW50UnVudGltZVN0YWNrLmFkZERlcGVuZGVuY3koaW1hZ2VTdGFjayk7XHJcbmFnZW50UnVudGltZVN0YWNrLmFkZERlcGVuZGVuY3koYXV0aFN0YWNrKTtcclxuYWdlbnRSdW50aW1lU3RhY2suYWRkRGVwZW5kZW5jeShhZ2VudENvcmVHYXRld2F5U3RhY2spO1xyXG5cclxuLy8gQWRkIHRhZ3MgdG8gYWxsIHN0YWNrc1xyXG5jZGsuVGFncy5vZihhcHApLmFkZCgnUHJvamVjdCcsICdGaW5PcHNBZ2VudCcpO1xyXG5jZGsuVGFncy5vZihhcHApLmFkZCgnTWFuYWdlZEJ5JywgJ0NESycpO1xyXG4iXX0=