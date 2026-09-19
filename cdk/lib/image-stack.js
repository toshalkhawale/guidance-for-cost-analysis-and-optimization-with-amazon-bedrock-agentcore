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
exports.ImageStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
/**
 * ImageStack: Builds Docker images for MCP server runtimes using the
 * stdio-to-HTTP transformation pattern.
 *
 * For each MCP server (billing, pricing):
 *   1. CodeBuild clones the upstream AWS Labs MCP repo
 *   2. transform-{server}.sh patches server.py for streamable-http transport
 *   3. Adds uvicorn + starlette dependencies
 *   4. Patches Dockerfile (EXPOSE 8000, entrypoint, healthcheck)
 *   5. Builds ARM64 Docker image and pushes to ECR
 *
 * Based on: https://github.com/aws-samples/sample-aws-stdio-http-proxy-mcp
 */
class ImageStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ECR Repository for Main Agent Runtime image
        this.repository = new ecr.Repository(this, 'RuntimeRepository', {
            repositoryName: 'finops-agent-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for Billing MCP Server Runtime
        this.billingMcpRepository = new ecr.Repository(this, 'BillingMcpRepository', {
            repositoryName: 'finops-billing-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for Pricing MCP Server Runtime
        this.pricingMcpRepository = new ecr.Repository(this, 'PricingMcpRepository', {
            repositoryName: 'finops-pricing-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // S3 Bucket for CodeBuild source (buildspec + transform scripts)
        this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            lifecycleRules: [
                { id: 'DeleteOldVersions', enabled: true, noncurrentVersionExpiration: cdk.Duration.days(30) },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // Upload codebuild-scripts to S3
        const scriptsDeployment = new s3deploy.BucketDeployment(this, 'CodeBuildScriptsDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../codebuild-scripts'))],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'codebuild-scripts/',
            extract: true,
            prune: false,
            retainOnDelete: false,
            memoryLimit: 512,
        });
        // Also upload agentcore directory for main runtime build
        const agentcoreDeployment = new s3deploy.BucketDeployment(this, 'AgentcoreSourceDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../agentcore'))],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'agentcore/',
        });
        // --- Build Trigger Lambda ---
        const buildTriggerFn = new lambda.Function(this, 'BuildTriggerFunction', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-trigger')),
            timeout: cdk.Duration.minutes(1),
            memorySize: 128,
            description: 'Triggers CodeBuild build for MCP server container',
        });
        // --- Build Waiter Lambda ---
        const buildWaiterFn = new lambda.Function(this, 'BuildWaiterFunction', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-waiter')),
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            description: 'Polls CodeBuild build status until completion',
        });
        // ========================================
        // Billing MCP Server - CodeBuild + Transform
        // ========================================
        const billingBuildProject = this.createTransformBuildProject('BillingMcp', this.billingMcpRepository, 'codebuild-scripts/', 'buildspec-billing.yml');
        billingBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [billingBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [billingBuildProject.projectArn],
        }));
        // Trigger billing build
        const billingBuildTrigger = new cdk.CustomResource(this, 'BillingBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: billingBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        billingBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for billing build
        const billingBuildWaiter = new cdk.CustomResource(this, 'BillingBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: billingBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        billingBuildWaiter.node.addDependency(billingBuildTrigger);
        // ========================================
        // Pricing MCP Server - CodeBuild + Transform
        // ========================================
        const pricingBuildProject = this.createTransformBuildProject('PricingMcp', this.pricingMcpRepository, 'codebuild-scripts/', 'buildspec-pricing.yml');
        pricingBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions for pricing
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [pricingBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [pricingBuildProject.projectArn],
        }));
        // Trigger pricing build
        const pricingBuildTrigger = new cdk.CustomResource(this, 'PricingBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: pricingBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        pricingBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for pricing build
        const pricingBuildWaiter = new cdk.CustomResource(this, 'PricingBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: pricingBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        pricingBuildWaiter.node.addDependency(pricingBuildTrigger);
        // ========================================
        // Main Agent Runtime - Standard Docker Build
        // ========================================
        this.buildMainRuntimeImage(agentcoreDeployment);
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'MainRepositoryUri', {
            value: this.repository.repositoryUri,
            description: 'Main Runtime ECR Repository URI',
            exportName: `${this.stackName}-MainRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'BillingMcpRepositoryUri', {
            value: this.billingMcpRepository.repositoryUri,
            description: 'Billing MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-BillingMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRepositoryUri', {
            value: this.pricingMcpRepository.repositoryUri,
            description: 'Pricing MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-PricingMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'SourceBucketName', {
            value: this.sourceBucket.bucketName,
            description: 'S3 bucket for CodeBuild source scripts',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(this.sourceBucket, [
            { id: 'AwsSolutions-S1', reason: 'Server access logging not enabled for dev/demo.' },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
            { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.' },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for S3, ECR, CloudWatch, CodeBuild.' },
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
        ]);
    }
    /**
     * Create a CodeBuild project that clones upstream MCP repo,
     * applies transformation scripts, builds ARM64 Docker image,
     * and pushes to ECR.
     */
    createTransformBuildProject(id, repository, sourcePath, buildspecFile) {
        const codeBuildRole = new iam.Role(this, `${id}CodeBuildRole`, {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description: `IAM role for CodeBuild to build ${id} container image`,
            inlinePolicies: {
                CloudWatchLogsPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                            resources: [`arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/*`],
                        })],
                }),
                ECRPushPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
                                'ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload',
                            ],
                            resources: [repository.repositoryArn],
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['ecr:GetAuthorizationToken'],
                            resources: ['*'],
                        }),
                    ],
                }),
                S3ReadPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:GetObjectVersion'],
                            resources: [this.sourceBucket.arnForObjects('*')],
                        })],
                }),
            },
        });
        const project = new codebuild.Project(this, `${id}BuildProject`, {
            projectName: `finops-${id.toLowerCase()}-build`,
            description: `Build ARM64 container for ${id} with streamable-http transport`,
            source: codebuild.Source.s3({
                bucket: this.sourceBucket,
                path: sourcePath,
            }),
            buildSpec: codebuild.BuildSpec.fromSourceFilename(buildspecFile),
            environment: {
                buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
                environmentVariables: {
                    AWS_DEFAULT_REGION: { value: cdk.Aws.REGION },
                    AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
                    ECR_REPO_URI: { value: repository.repositoryUri },
                },
            },
            role: codeBuildRole,
            timeout: cdk.Duration.minutes(30),
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(codeBuildRole, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ecr:GetAuthorizationToken, S3, CloudWatch Logs.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(project, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
        ]);
        return project;
    }
    /**
     * Build the main agent runtime image using standard Docker build
     * (no transformation needed - it's our own code).
     */
    buildMainRuntimeImage(sourceDeployment) {
        const buildProject = new codebuild.Project(this, 'MainRuntimeBuildProject', {
            projectName: 'finops-mainruntime-build',
            source: codebuild.Source.s3({
                bucket: this.sourceBucket,
                path: 'agentcore/',
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
                privileged: true,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                AWS_DEFAULT_REGION: { value: this.region },
                AWS_ACCOUNT_ID: { value: this.account },
                IMAGE_REPO_NAME: { value: this.repository.repositoryName },
                IMAGE_TAG: { value: 'latest' },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo Logging in to Amazon ECR...',
                            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
                        ],
                    },
                    build: {
                        commands: [
                            'echo Building the Docker image...',
                            'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
                            'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                        ],
                    },
                    post_build: {
                        commands: [
                            'echo Pushing the Docker image...',
                            'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                        ],
                    },
                },
            }),
        });
        this.repository.grantPullPush(buildProject);
        this.sourceBucket.grantRead(buildProject);
        buildProject.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));
        const triggerFn = new cdk.aws_lambda.Function(this, 'MainRuntimeBuildTriggerFn', {
            runtime: cdk.aws_lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-trigger')),
            timeout: cdk.Duration.minutes(1),
        });
        triggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [buildProject.projectArn],
        }));
        triggerFn.node.addDependency(sourceDeployment);
        new cdk.CustomResource(this, 'MainRuntimeTriggerBuild', {
            serviceToken: triggerFn.functionArn,
            properties: {
                ProjectName: buildProject.projectName,
                Timestamp: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
            },
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(buildProject, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ECR, S3, CloudWatch.' },
        ], true);
    }
}
exports.ImageStack = ImageStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1hZ2Utc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbWFnZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHFFQUF1RDtBQUN2RCx5REFBMkM7QUFDM0MsdURBQXlDO0FBQ3pDLHdFQUEwRDtBQUMxRCwrREFBaUQ7QUFFakQsMkNBQTZCO0FBQzdCLHFDQUEwQztBQUUxQzs7Ozs7Ozs7Ozs7O0dBWUc7QUFDSCxNQUFhLFVBQVcsU0FBUSxHQUFHLENBQUMsS0FBSztJQU12QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDhDQUE4QztRQUM5QyxJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDOUQsY0FBYyxFQUFFLHNCQUFzQjtZQUN0QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGFBQWEsRUFBRSxJQUFJO1lBQ25CLGVBQWUsRUFBRSxJQUFJO1lBQ3JCLGNBQWMsRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLHFCQUFxQixFQUFFLGFBQWEsRUFBRSxFQUFFLEVBQUUsQ0FBQztTQUM1RSxDQUFDLENBQUM7UUFFSCxnREFBZ0Q7UUFDaEQsSUFBSSxDQUFDLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDM0UsY0FBYyxFQUFFLDRCQUE0QjtZQUM1QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGFBQWEsRUFBRSxJQUFJO1lBQ25CLGVBQWUsRUFBRSxJQUFJO1lBQ3JCLGNBQWMsRUFBRSxDQUFDLEVB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TSxFQUFFLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRTthQUN0RTtTQUNGLENBQUMsQ0FBQztRQUVILHlCQUFlLENBQUMsdUJBQXVCLENBQUMsWUFBWSxFQUFFO1lBQ3BELEVBQUUsRUFBRSxFQUFFLGtCQUFrQixFQUFFLE1BQU0sRUFBRSwwQ0FBMEMsRUFBRTtZQUM5RSxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsbUNBQW1DLEVBQUU7U0FDekUsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNYLENBQUM7Q0FDRjtBQS9YRCxnQ0ErWEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xyXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XHJcbmltcG9ydCAqIGFzIGNvZGVidWlsZCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29kZWJ1aWxkJztcclxuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xyXG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xyXG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudCc7XHJcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcclxuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XHJcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xyXG5cclxuLyoqXHJcbiAqIEltYWdlU3RhY2s6IEJ1aWxkcyBEb2NrZXIgaW1hZ2VzIGZvciBNQ1Agc2VydmVyIHJ1bnRpbWVzIHVzaW5nIHRoZVxyXG4gKiBzdGRpby10by1IVFRQIHRyYW5zZm9ybWF0aW9uIHBhdHRlcm4uXHJcbiAqXHJcbiAqIEZvciBlYWNoIE1DUCBzZXJ2ZXIgKGJpbGxpbmcsIHByaWNpbmcpOlxyXG4gKiAgIDEuIENvZGVCdWlsZCBjbG9uZXMgdGhlIHVwc3RyZWFtIEFXUyBMYWJzIE1DUCByZXBvXHJcbiAqICAgMi4gdHJhbnNmb3JtLXtzZXJ2ZXJ9LnNoIHBhdGNoZXMgc2VydmVyLnB5IGZvciBzdHJlYW1hYmxlLWh0dHAgdHJhbnNwb3J0XHJcbiAqICAgMy4gQWRkcyB1dmljb3JuICsgc3RhcmxldHRlIGRlcGVuZGVuY2llc1xyXG4gKiAgIDQuIFBhdGNoZXMgRG9ja2VyZmlsZSAoRVhQT1NFIDgwMDAsIGVudHJ5cG9pbnQsIGhlYWx0aGNoZWNrKVxyXG4gKiAgIDUuIEJ1aWxkcyBBUk02NCBEb2NrZXIgaW1hZ2UgYW5kIHB1c2hlcyB0byBFQ1JcclxuICpcclxuICogQmFzZWQgb246IGh0dHBzOi8vZ2l0aHViLmNvbS9hd3Mtc2FtcGxlcy9zYW1wbGUtYXdzLXN0ZGlvLWh0dHAtcHJveHktbWNwXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgSW1hZ2VTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XHJcbiAgcHVibGljIHJlYWRvbmx5IHJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xyXG4gIHB1YmxpYyByZWFkb25seSBiaWxsaW5nTWNwUmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnk7XHJcbiAgcHVibGljIHJlYWRvbmx5IHByaWNpbmdNY3BSZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcclxuICBwdWJsaWMgcmVhZG9ubHkgc291cmNlQnVja2V0OiBzMy5CdWNrZXQ7XHJcblxyXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcclxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBNYWluIEFnZW50IFJ1bnRpbWUgaW1hZ2VcclxuICAgIHRoaXMucmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnUnVudGltZVJlcG9zaXRvcnknLCB7XHJcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnZmlub3BzLWFnZW50LXJ1bnRpbWUnLFxyXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxyXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBCaWxsaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxyXG4gICAgdGhpcy5iaWxsaW5nTWNwUmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnQmlsbGluZ01jcFJlcG9zaXRvcnknLCB7XHJcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnZmlub3BzLWJpbGxpbmctbWNwLXJ1bnRpbWUnLFxyXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxyXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxyXG4gICAgdGhpcy5wcmljaW5nTWNwUmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnUHJpY2luZ01jcFJlcG9zaXRvcnknLCB7XHJcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnZmlub3BzLXByaWNpbmctbWNwLXJ1bnRpbWUnLFxyXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxyXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFMzIEJ1Y2tldCBmb3IgQ29kZUJ1aWxkIHNvdXJjZSAoYnVpbGRzcGVjICsgdHJhbnNmb3JtIHNjcmlwdHMpXHJcbiAgICB0aGlzLnNvdXJjZUJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ1NvdXJjZUJ1Y2tldCcsIHtcclxuICAgICAgdmVyc2lvbmVkOiB0cnVlLFxyXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxyXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXHJcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXHJcbiAgICAgICAgeyBpZDogJ0RlbGV0ZU9sZFZlcnNpb25zJywgZW5hYmxlZDogdHJ1ZSwgbm9uY3VycmVudFZlcnNpb25FeHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCkgfSxcclxuICAgICAgXSxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBVcGxvYWQgY29kZWJ1aWxkLXNjcmlwdHMgdG8gUzNcclxuICAgIGNvbnN0IHNjcmlwdHNEZXBsb3ltZW50ID0gbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgJ0NvZGVCdWlsZFNjcmlwdHNEZXBsb3ltZW50Jywge1xyXG4gICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9jb2RlYnVpbGQtc2NyaXB0cycpKV0sXHJcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcclxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICdjb2RlYnVpbGQtc2NyaXB0cy8nLFxyXG4gICAgICBleHRyYWN0OiB0cnVlLFxyXG4gICAgICBwcnVuZTogZmFsc2UsXHJcbiAgICAgIHJldGFpbk9uRGVsZXRlOiBmYWxzZSxcclxuICAgICAgbWVtb3J5TGltaXQ6IDUxMixcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEFsc28gdXBsb2FkIGFnZW50Y29yZSBkaXJlY3RvcnkgZm9yIG1haW4gcnVudGltZSBidWlsZFxyXG4gICAgY29uc3QgYWdlbnRjb3JlRGVwbG95bWVudCA9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdBZ2VudGNvcmVTb3VyY2VEZXBsb3ltZW50Jywge1xyXG4gICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9hZ2VudGNvcmUnKSldLFxyXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXHJcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnYWdlbnRjb3JlLycsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0gQnVpbGQgVHJpZ2dlciBMYW1iZGEgLS0tXHJcbiAgICBjb25zdCBidWlsZFRyaWdnZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0J1aWxkVHJpZ2dlckZ1bmN0aW9uJywge1xyXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xNCxcclxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2xhbWJkYS9idWlsZC10cmlnZ2VyJykpLFxyXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcclxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1RyaWdnZXJzIENvZGVCdWlsZCBidWlsZCBmb3IgTUNQIHNlcnZlciBjb250YWluZXInLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tIEJ1aWxkIFdhaXRlciBMYW1iZGEgLS0tXHJcbiAgICBjb25zdCBidWlsZFdhaXRlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQnVpbGRXYWl0ZXJGdW5jdGlvbicsIHtcclxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXHJcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9sYW1iZGEvYnVpbGQtd2FpdGVyJykpLFxyXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXHJcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcclxuICAgICAgZGVzY3JpcHRpb246ICdQb2xscyBDb2RlQnVpbGQgYnVpbGQgc3RhdHVzIHVudGlsIGNvbXBsZXRpb24nLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gQmlsbGluZyBNQ1AgU2VydmVyIC0gQ29kZUJ1aWxkICsgVHJhbnNmb3JtXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICBjb25zdCBiaWxsaW5nQnVpbGRQcm9qZWN0ID0gdGhpcy5jcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXHJcbiAgICAgICdCaWxsaW5nTWNwJyxcclxuICAgICAgdGhpcy5iaWxsaW5nTWNwUmVwb3NpdG9yeSxcclxuICAgICAgJ2NvZGVidWlsZC1zY3JpcHRzLycsXHJcbiAgICAgICdidWlsZHNwZWMtYmlsbGluZy55bWwnLFxyXG4gICAgKTtcclxuICAgIGJpbGxpbmdCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcclxuXHJcbiAgICAvLyBHcmFudCBMYW1iZGEgcGVybWlzc2lvbnNcclxuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCddLFxyXG4gICAgICByZXNvdXJjZXM6IFtiaWxsaW5nQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxyXG4gICAgfSkpO1xyXG4gICAgYnVpbGRXYWl0ZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXHJcbiAgICAgIHJlc291cmNlczogW2JpbGxpbmdCdWlsZFByb2plY3QucHJvamVjdEFybl0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gVHJpZ2dlciBiaWxsaW5nIGJ1aWxkXHJcbiAgICBjb25zdCBiaWxsaW5nQnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ0J1aWxkVHJpZ2dlcicsIHtcclxuICAgICAgc2VydmljZVRva2VuOiBidWlsZFRyaWdnZXJGbi5mdW5jdGlvbkFybixcclxuICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgIFByb2plY3ROYW1lOiBiaWxsaW5nQnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBiaWxsaW5nQnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgYmlsbGluZyBidWlsZFxyXG4gICAgY29uc3QgYmlsbGluZ0J1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ0J1aWxkV2FpdGVyJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRm4uZnVuY3Rpb25Bcm4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBCdWlsZElkOiBiaWxsaW5nQnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxyXG4gICAgICAgIE1heFdhaXRTZWNvbmRzOiAnMTIwMCcsXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGJpbGxpbmdCdWlsZFdhaXRlci5ub2RlLmFkZERlcGVuZGVuY3koYmlsbGluZ0J1aWxkVHJpZ2dlcik7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gUHJpY2luZyBNQ1AgU2VydmVyIC0gQ29kZUJ1aWxkICsgVHJhbnNmb3JtXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICBjb25zdCBwcmljaW5nQnVpbGRQcm9qZWN0ID0gdGhpcy5jcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXHJcbiAgICAgICdQcmljaW5nTWNwJyxcclxuICAgICAgdGhpcy5wcmljaW5nTWNwUmVwb3NpdG9yeSxcclxuICAgICAgJ2NvZGVidWlsZC1zY3JpcHRzLycsXHJcbiAgICAgICdidWlsZHNwZWMtcHJpY2luZy55bWwnLFxyXG4gICAgKTtcclxuICAgIHByaWNpbmdCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcclxuXHJcbiAgICAvLyBHcmFudCBMYW1iZGEgcGVybWlzc2lvbnMgZm9yIHByaWNpbmdcclxuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCddLFxyXG4gICAgICByZXNvdXJjZXM6IFtwcmljaW5nQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxyXG4gICAgfSkpO1xyXG4gICAgYnVpbGRXYWl0ZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXHJcbiAgICAgIHJlc291cmNlczogW3ByaWNpbmdCdWlsZFByb2plY3QucHJvamVjdEFybl0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gVHJpZ2dlciBwcmljaW5nIGJ1aWxkXHJcbiAgICBjb25zdCBwcmljaW5nQnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ0J1aWxkVHJpZ2dlcicsIHtcclxuICAgICAgc2VydmljZVRva2VuOiBidWlsZFRyaWdnZXJGbi5mdW5jdGlvbkFybixcclxuICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgIFByb2plY3ROYW1lOiBwcmljaW5nQnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBwcmljaW5nQnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgcHJpY2luZyBidWlsZFxyXG4gICAgY29uc3QgcHJpY2luZ0J1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ0J1aWxkV2FpdGVyJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRm4uZnVuY3Rpb25Bcm4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBCdWlsZElkOiBwcmljaW5nQnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxyXG4gICAgICAgIE1heFdhaXRTZWNvbmRzOiAnMTIwMCcsXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHByaWNpbmdCdWlsZFdhaXRlci5ub2RlLmFkZERlcGVuZGVuY3kocHJpY2luZ0J1aWxkVHJpZ2dlcik7XHJcblxyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lIC0gU3RhbmRhcmQgRG9ja2VyIEJ1aWxkXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICB0aGlzLmJ1aWxkTWFpblJ1bnRpbWVJbWFnZShhZ2VudGNvcmVEZXBsb3ltZW50KTtcclxuXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAvLyBPdXRwdXRzXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTWFpblJlcG9zaXRvcnlVcmknLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcclxuICAgICAgZGVzY3JpcHRpb246ICdNYWluIFJ1bnRpbWUgRUNSIFJlcG9zaXRvcnkgVVJJJyxcclxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1haW5SZXBvc2l0b3J5VXJpYCxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCaWxsaW5nTWNwUmVwb3NpdG9yeVVyaScsIHtcclxuICAgICAgdmFsdWU6IHRoaXMuYmlsbGluZ01jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcclxuICAgICAgZGVzY3JpcHRpb246ICdCaWxsaW5nIE1DUCBSdW50aW1lIEVDUiBSZXBvc2l0b3J5IFVSSScsXHJcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUmVwb3NpdG9yeVVyaWAsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUHJpY2luZ01jcFJlcG9zaXRvcnlVcmknLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLnByaWNpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpY2luZyBNQ1AgUnVudGltZSBFQ1IgUmVwb3NpdG9yeSBVUkknLFxyXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUHJpY2luZ01jcFJlcG9zaXRvcnlVcmlgLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NvdXJjZUJ1Y2tldE5hbWUnLCB7XHJcbiAgICAgIHZhbHVlOiB0aGlzLnNvdXJjZUJ1Y2tldC5idWNrZXROYW1lLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1MzIGJ1Y2tldCBmb3IgQ29kZUJ1aWxkIHNvdXJjZSBzY3JpcHRzJyxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXHJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModGhpcy5zb3VyY2VCdWNrZXQsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1TMScsIHJlYXNvbjogJ1NlcnZlciBhY2Nlc3MgbG9nZ2luZyBub3QgZW5hYmxlZCBmb3IgZGV2L2RlbW8uJyB9LFxyXG4gICAgXSk7XHJcblxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1MMScsIHJlYXNvbjogJ0xhbWJkYSBydW50aW1lIHZlcnNpb24gbWFuYWdlZCBieSBDREsuJyB9LFxyXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLCByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgQVdTIGJlc3QgcHJhY3RpY2UuJyB9LFxyXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgUzMsIEVDUiwgQ2xvdWRXYXRjaCwgQ29kZUJ1aWxkLicgfSxcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLCByZWFzb246ICdLTVMgZW5jcnlwdGlvbiBub3QgZW5hYmxlZCBmb3IgZGV2L2RlbW8uJyB9LFxyXG4gICAgXSk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBDcmVhdGUgYSBDb2RlQnVpbGQgcHJvamVjdCB0aGF0IGNsb25lcyB1cHN0cmVhbSBNQ1AgcmVwbyxcclxuICAgKiBhcHBsaWVzIHRyYW5zZm9ybWF0aW9uIHNjcmlwdHMsIGJ1aWxkcyBBUk02NCBEb2NrZXIgaW1hZ2UsXHJcbiAgICogYW5kIHB1c2hlcyB0byBFQ1IuXHJcbiAgICovXHJcbiAgcHJpdmF0ZSBjcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXHJcbiAgICBpZDogc3RyaW5nLFxyXG4gICAgcmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnksXHJcbiAgICBzb3VyY2VQYXRoOiBzdHJpbmcsXHJcbiAgICBidWlsZHNwZWNGaWxlOiBzdHJpbmcsXHJcbiAgKTogY29kZWJ1aWxkLlByb2plY3Qge1xyXG4gICAgY29uc3QgY29kZUJ1aWxkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBgJHtpZH1Db2RlQnVpbGRSb2xlYCwge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY29kZWJ1aWxkLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgZGVzY3JpcHRpb246IGBJQU0gcm9sZSBmb3IgQ29kZUJ1aWxkIHRvIGJ1aWxkICR7aWR9IGNvbnRhaW5lciBpbWFnZWAsXHJcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XHJcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3NQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xyXG4gICAgICAgICAgc3RhdGVtZW50czogW25ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLCAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLCAnbG9nczpQdXRMb2dFdmVudHMnXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke2Nkay5Bd3MuUkVHSU9OfToke2Nkay5Bd3MuQUNDT1VOVF9JRH06bG9nLWdyb3VwOi9hd3MvY29kZWJ1aWxkLypgXSxcclxuICAgICAgICAgIH0pXSxcclxuICAgICAgICB9KSxcclxuICAgICAgICBFQ1JQdXNoUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcclxuICAgICAgICAgIHN0YXRlbWVudHM6IFtcclxuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsICdlY3I6QmF0Y2hHZXRJbWFnZScsXHJcbiAgICAgICAgICAgICAgICAnZWNyOlB1dEltYWdlJywgJ2VjcjpJbml0aWF0ZUxheWVyVXBsb2FkJywgJ2VjcjpVcGxvYWRMYXllclBhcnQnLCAnZWNyOkNvbXBsZXRlTGF5ZXJVcGxvYWQnLFxyXG4gICAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbcmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuXSxcclxuICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXHJcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcclxuICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIFMzUmVhZFBvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XHJcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnczM6R2V0T2JqZWN0JywgJ3MzOkdldE9iamVjdFZlcnNpb24nXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5zb3VyY2VCdWNrZXQuYXJuRm9yT2JqZWN0cygnKicpXSxcclxuICAgICAgICAgIH0pXSxcclxuICAgICAgICB9KSxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IHByb2plY3QgPSBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgYCR7aWR9QnVpbGRQcm9qZWN0YCwge1xyXG4gICAgICBwcm9qZWN0TmFtZTogYGZpbm9wcy0ke2lkLnRvTG93ZXJDYXNlKCl9LWJ1aWxkYCxcclxuICAgICAgZGVzY3JpcHRpb246IGBCdWlsZCBBUk02NCBjb250YWluZXIgZm9yICR7aWR9IHdpdGggc3RyZWFtYWJsZS1odHRwIHRyYW5zcG9ydGAsXHJcbiAgICAgIHNvdXJjZTogY29kZWJ1aWxkLlNvdXJjZS5zMyh7XHJcbiAgICAgICAgYnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcclxuICAgICAgICBwYXRoOiBzb3VyY2VQYXRoLFxyXG4gICAgICB9KSxcclxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21Tb3VyY2VGaWxlbmFtZShidWlsZHNwZWNGaWxlKSxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhBcm1CdWlsZEltYWdlLkFNQVpPTl9MSU5VWF8yX1NUQU5EQVJEXzNfMCxcclxuICAgICAgICBjb21wdXRlVHlwZTogY29kZWJ1aWxkLkNvbXB1dGVUeXBlLlNNQUxMLFxyXG4gICAgICAgIHByaXZpbGVnZWQ6IHRydWUsXHJcbiAgICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogeyB2YWx1ZTogY2RrLkF3cy5SRUdJT04gfSxcclxuICAgICAgICAgIEFXU19BQ0NPVU5UX0lEOiB7IHZhbHVlOiBjZGsuQXdzLkFDQ09VTlRfSUQgfSxcclxuICAgICAgICAgIEVDUl9SRVBPX1VSSTogeyB2YWx1ZTogcmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgcm9sZTogY29kZUJ1aWxkUm9sZSxcclxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMzApLFxyXG4gICAgfSk7XHJcblxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGNvZGVCdWlsZFJvbGUsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIGVjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4sIFMzLCBDbG91ZFdhdGNoIExvZ3MuJyB9LFxyXG4gICAgXSwgdHJ1ZSk7XHJcblxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHByb2plY3QsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLCByZWFzb246ICdLTVMgZW5jcnlwdGlvbiBub3QgZW5hYmxlZCBmb3IgZGV2L2RlbW8uJyB9LFxyXG4gICAgXSk7XHJcblxyXG4gICAgcmV0dXJuIHByb2plY3Q7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBCdWlsZCB0aGUgbWFpbiBhZ2VudCBydW50aW1lIGltYWdlIHVzaW5nIHN0YW5kYXJkIERvY2tlciBidWlsZFxyXG4gICAqIChubyB0cmFuc2Zvcm1hdGlvbiBuZWVkZWQgLSBpdCdzIG91ciBvd24gY29kZSkuXHJcbiAgICovXHJcbiAgcHJpdmF0ZSBidWlsZE1haW5SdW50aW1lSW1hZ2Uoc291cmNlRGVwbG95bWVudDogczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnVpbGRQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdNYWluUnVudGltZUJ1aWxkUHJvamVjdCcsIHtcclxuICAgICAgcHJvamVjdE5hbWU6ICdmaW5vcHMtbWFpbnJ1bnRpbWUtYnVpbGQnLFxyXG4gICAgICBzb3VyY2U6IGNvZGVidWlsZC5Tb3VyY2UuczMoe1xyXG4gICAgICAgIGJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXHJcbiAgICAgICAgcGF0aDogJ2FnZW50Y29yZS8nLFxyXG4gICAgICB9KSxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLkFNQVpPTl9MSU5VWF8yX0FSTV8zLFxyXG4gICAgICAgIHByaXZpbGVnZWQ6IHRydWUsXHJcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5TTUFMTCxcclxuICAgICAgfSxcclxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHsgdmFsdWU6IHRoaXMucmVnaW9uIH0sXHJcbiAgICAgICAgQVdTX0FDQ09VTlRfSUQ6IHsgdmFsdWU6IHRoaXMuYWNjb3VudCB9LFxyXG4gICAgICAgIElNQUdFX1JFUE9fTkFNRTogeyB2YWx1ZTogdGhpcy5yZXBvc2l0b3J5LnJlcG9zaXRvcnlOYW1lIH0sXHJcbiAgICAgICAgSU1BR0VfVEFHOiB7IHZhbHVlOiAnbGF0ZXN0JyB9LFxyXG4gICAgICB9LFxyXG4gICAgICBidWlsZFNwZWM6IGNvZGVidWlsZC5CdWlsZFNwZWMuZnJvbU9iamVjdCh7XHJcbiAgICAgICAgdmVyc2lvbjogJzAuMicsXHJcbiAgICAgICAgcGhhc2VzOiB7XHJcbiAgICAgICAgICBwcmVfYnVpbGQ6IHtcclxuICAgICAgICAgICAgY29tbWFuZHM6IFtcclxuICAgICAgICAgICAgICAnZWNobyBMb2dnaW5nIGluIHRvIEFtYXpvbiBFQ1IuLi4nLFxyXG4gICAgICAgICAgICAgICdhd3MgZWNyIGdldC1sb2dpbi1wYXNzd29yZCAtLXJlZ2lvbiAkQVdTX0RFRkFVTFRfUkVHSU9OIHwgZG9ja2VyIGxvZ2luIC0tdXNlcm5hbWUgQVdTIC0tcGFzc3dvcmQtc3RkaW4gJEFXU19BQ0NPVU5UX0lELmRrci5lY3IuJEFXU19ERUZBVUxUX1JFR0lPTi5hbWF6b25hd3MuY29tJyxcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBidWlsZDoge1xyXG4gICAgICAgICAgICBjb21tYW5kczogW1xyXG4gICAgICAgICAgICAgICdlY2hvIEJ1aWxkaW5nIHRoZSBEb2NrZXIgaW1hZ2UuLi4nLFxyXG4gICAgICAgICAgICAgICdkb2NrZXIgYnVpbGQgLXQgJElNQUdFX1JFUE9fTkFNRTokSU1BR0VfVEFHIC4nLFxyXG4gICAgICAgICAgICAgICdkb2NrZXIgdGFnICRJTUFHRV9SRVBPX05BTUU6JElNQUdFX1RBRyAkQVdTX0FDQ09VTlRfSUQuZGtyLmVjci4kQVdTX0RFRkFVTFRfUkVHSU9OLmFtYXpvbmF3cy5jb20vJElNQUdFX1JFUE9fTkFNRTokSU1BR0VfVEFHJyxcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBwb3N0X2J1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ2VjaG8gUHVzaGluZyB0aGUgRG9ja2VyIGltYWdlLi4uJyxcclxuICAgICAgICAgICAgICAnZG9ja2VyIHB1c2ggJEFXU19BQ0NPVU5UX0lELmRrci5lY3IuJEFXU19ERUZBVUxUX1JFR0lPTi5hbWF6b25hd3MuY29tLyRJTUFHRV9SRVBPX05BTUU6JElNQUdFX1RBRycsXHJcbiAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pLFxyXG4gICAgfSk7XHJcblxyXG4gICAgdGhpcy5yZXBvc2l0b3J5LmdyYW50UHVsbFB1c2goYnVpbGRQcm9qZWN0KTtcclxuICAgIHRoaXMuc291cmNlQnVja2V0LmdyYW50UmVhZChidWlsZFByb2plY3QpO1xyXG4gICAgYnVpbGRQcm9qZWN0LmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXHJcbiAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3QgdHJpZ2dlckZuID0gbmV3IGNkay5hd3NfbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdNYWluUnVudGltZUJ1aWxkVHJpZ2dlckZuJywge1xyXG4gICAgICBydW50aW1lOiBjZGsuYXdzX2xhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxyXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXHJcbiAgICAgIGNvZGU6IGNkay5hd3NfbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9sYW1iZGEvYnVpbGQtdHJpZ2dlcicpKSxcclxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXHJcbiAgICB9KTtcclxuICAgIHRyaWdnZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnXSxcclxuICAgICAgcmVzb3VyY2VzOiBbYnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxyXG4gICAgfSkpO1xyXG4gICAgdHJpZ2dlckZuLm5vZGUuYWRkRGVwZW5kZW5jeShzb3VyY2VEZXBsb3ltZW50KTtcclxuXHJcbiAgICBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdNYWluUnVudGltZVRyaWdnZXJCdWlsZCcsIHtcclxuICAgICAgc2VydmljZVRva2VuOiB0cmlnZ2VyRm4uZnVuY3Rpb25Bcm4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBQcm9qZWN0TmFtZTogYnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgIFRpbWVzdGFtcDogYCR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoNyl9YCxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhidWlsZFByb2plY3QsIFtcclxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLCByZWFzb246ICdLTVMgZW5jcnlwdGlvbiBub3QgZW5hYmxlZCBmb3IgZGV2L2RlbW8uJyB9LFxyXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBmb3IgRUNSLCBTMywgQ2xvdWRXYXRjaC4nIH0sXHJcbiAgICBdLCB0cnVlKTtcclxuICB9XHJcbn1cclxuIl19