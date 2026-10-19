import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { SharedAlarms } from './shared-alerts';
import { type SharedAuthConfig, sharedAuthRegion } from './shared-auth';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface BackendStackProps extends StackProps {
  envName: string;
  /**
   * 共通ログインの接続先（cdk.json の context `sharedAuth`）。
   * API はこのユーザープールが learning のクライアントに発行したアクセストークンだけを通す
   */
  sharedAuth: SharedAuthConfig;
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
    const { envName, sharedAuth, allowedOrigins } = props;

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
      logGroupName: `/aws/lambda/sakekasu-learning-${envName}-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      // RETAIN にしておく。DESTROY のままだと、名前を変えたときに cdkd が「ログが消える」として
      // 作り直しを拒む（2026-10-11 のデプロイが止まった）。古いロググループは残り、保持期間で中身が消える
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const fn = new NodejsFunction(this, 'ApiFunction', {
      functionName: `sakekasu-learning-${envName}-api`,
      entry: path.join(here, '../lambda/api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // CPU はメモリに比例して割り当てられる。512MB だとコールドスタートと問題 JSON（数 MB）の
      // 解析に 1 秒前後かかっていたため、1 vCPU 分を割り当てる（利用は少ないので費用はほぼ増えない）
      memorySize: 1769,
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

    // 実行環境は 5 分ほど呼ばれないと回収され、1 問を考えている間に冷えて「回答する」が
    // 1 秒前後待たされていた（2026-10 のログで、回答の約 4 割がコールドスタートだった）。
    // 回収される前に呼んで 1 環境を温めておく。問題 JSON の読み込みもこの呼び出しで済ませる
    new events.Rule(this, 'ApiWarmerRule', {
      ruleName: `sakekasu-learning-${envName}-api-warmer`,
      description: 'Keep the learning API Lambda warm (avoid cold starts)',
      schedule: events.Schedule.rate(Duration.minutes(4)),
      targets: [
        new targets.LambdaFunction(fn, {
          event: events.RuleTargetInput.fromObject({ warmup: true }),
          // 温めそこねても次の回があるので、再試行はしない
          retryAttempts: 0,
        }),
      ],
    });

    // 共通ユーザープールは別のリポジトリ（sakekasu-integrated_environment）が持つので、ID から参照する。
    const userPool = cognito.UserPool.fromUserPoolId(this, 'SharedUserPool', sharedAuth.userPoolId);
    const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      'SharedUserPoolClient',
      sharedAuth.clientId,
    );
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
      userPoolRegion: sharedAuthRegion(sharedAuth),
    });

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `sakekasu-learning-${envName}-api`,
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

    // --- 監視（共通基盤のトピックへ ALARM と OK を送る。docs/monitoring.md）---
    const alarms = new SharedAlarms(this, 'Alarms', { envName });
    const fiveMinutes = Duration.minutes(5);

    // ハンドラーは想定外の例外を 500 にして返すので、Errors に出るのはタイムアウトや
    // 初期化の失敗など、ハンドラーの外で落ちたものだけ。1 回でも出たら見る
    alarms.add('ApiErrors', {
      name: 'api-errors',
      description:
        '学習 API の Lambda が異常終了しています（タイムアウトや起動時の失敗）。' +
        `まず CloudWatch Logs の /aws/lambda/sakekasu-learning-${envName}-api を見る`,
      metric: fn.metricErrors({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 1,
    });

    alarms.add('ApiThrottles', {
      name: 'api-throttles',
      description:
        '学習 API の Lambda がスロットリングされています（同時実行数の上限）。' +
        'まず Lambda の ConcurrentExecutions と、同じアカウントの他のアプリの Lambda を見る',
      metric: fn.metricThrottles({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 1,
    });

    // ハンドラーの中で捕まえた例外（S3・DynamoDB の失敗など）は 500 になってここに出る。
    // 一時的な 1 回で鳴らさないよう、5 分に 3 回から
    alarms.add('Api5xx', {
      name: 'api-5xx',
      description:
        '学習 API が 5xx を返しています（問題の表示や回答の記録に失敗しています）。' +
        `まず CloudWatch Logs の /aws/lambda/sakekasu-learning-${envName}-api で internal error の直前のログを見る`,
      metric: this.httpApi.metricServerError({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 3,
    });

    // ThrottledRequests は Operation のディメンションつきでしか出ないので、
    // テーブル単位で出る Read/WriteThrottleEvents を足し合わせて見る
    const throttleMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName,
        dimensionsMap: { TableName: this.progressTable.tableName },
        statistic: 'Sum',
        period: fiveMinutes,
      });
    alarms.add('ProgressTableThrottles', {
      name: 'progress-throttles',
      description:
        '回答履歴のテーブルで読み書きがスロットリングされています（回答の記録や習熟度の表示に失敗します）。' +
        'まず DynamoDB の ReadThrottleEvents / WriteThrottleEvents と、API の 5xx を見る',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(r, 0) + FILL(w, 0)',
        usingMetrics: {
          r: throttleMetric('ReadThrottleEvents'),
          w: throttleMetric('WriteThrottleEvents'),
        },
        label: 'ThrottleEvents',
        period: fiveMinutes,
      }),
      threshold: 1,
    });

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'QuestionsBucketName', { value: this.questionsBucket.bucketName });
    new CfnOutput(this, 'ProgressTableName', { value: this.progressTable.tableName });
  }
}
