import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface BackendStackProps extends StackProps {
  envName: string;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  /** CORS で許可するオリジン */
  allowedOrigins: string[];
}

/**
 * 問題データ（非公開 S3）・回答履歴（DynamoDB）・学習 API（HTTP API + Lambda）。
 */
export class BackendStack extends Stack {
  readonly questionsBucket: s3.Bucket;
  readonly progressTable: dynamodb.TableV2;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);
    const { envName, userPool, userPoolClient, allowedOrigins } = props;

    // 問題の原本は Git にあり、CI が毎回 sync し直すため作り直しても失うものはない。
    // ただしバケット名を固定しているので、消してしまうと再作成までの間 CI が落ちる
    this.questionsBucket = new s3.Bucket(this, 'QuestionsBucket', {
      bucketName: `sakekasu-learning-${envName}-questions-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.progressTable = new dynamodb.TableV2(this, 'ProgressTable', {
      tableName: `${envName}-sakekasu-learning-progress`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'qkey', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const logGroup = new logs.LogGroup(this, 'ApiFunctionLogs', {
      logGroupName: `/aws/lambda/${envName}-sakekasu-learning-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'ApiFunction', {
      functionName: `${envName}-sakekasu-learning-api`,
      entry: path.join(here, '../lambda/api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logGroup,
      environment: {
        QUESTIONS_BUCKET_NAME: this.questionsBucket.bucketName,
        PROGRESS_TABLE_NAME: this.progressTable.tableName,
      },
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        target: 'node22',
        // ESM で CommonJS 依存（AWS SDK の一部）を読むための require 定義
        banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
      },
    });
    this.questionsBucket.grantRead(fn);
    this.progressTable.grantReadWriteData(fn);

    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${envName}-sakekasu-learning-api`,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    const routes: [string, apigw.HttpMethod][] = [
      ['/catalog', apigw.HttpMethod.GET],
      ['/exams/{category}/{exam}/questions', apigw.HttpMethod.GET],
      ['/exams/{category}/{exam}/questions/{id}', apigw.HttpMethod.GET],
      ['/exams/{category}/{exam}/questions/{id}/answer', apigw.HttpMethod.POST],
      ['/exams/{category}/{exam}/questions/{id}/diagrams/{choice}', apigw.HttpMethod.GET],
      ['/exams/{category}/{exam}/progress', apigw.HttpMethod.DELETE],
    ];
    for (const [routePath, method] of routes) {
      this.httpApi.addRoutes({ path: routePath, methods: [method], integration });
    }

    // 招待制の小規模利用なので、既定のスロットリングを低めにして暴走時の課金を抑える
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'QuestionsBucketName', { value: this.questionsBucket.bucketName });
    new CfnOutput(this, 'ProgressTableName', { value: this.progressTable.tableName });
  }
}
