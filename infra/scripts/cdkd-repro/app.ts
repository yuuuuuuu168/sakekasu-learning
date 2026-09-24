/**
 * cdkd の不具合の再現用アプリ（issue に書く前の確認用。確認が済んだら消す）。
 *
 * - cdkd-repro-region:  us-east-1 のスタック（S3 バケット 1 つ）。既定のリージョンが別だと import できないことの確認
 * - cdkd-repro-cognito: User Pool と UserPoolClient。CloudFormation から引いた ID で UserPoolClient を import できないことの確認
 *
 * どちらも中身が空で、削除すると消える（RemovalPolicy.DESTROY）。
 */
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

const region = new cdk.Stack(app, 'cdkd-repro-region', { env: { account, region: 'us-east-1' } });
new s3.Bucket(region, 'Bucket', { removalPolicy: cdk.RemovalPolicy.DESTROY });

const auth = new cdk.Stack(app, 'cdkd-repro-cognito', { env: { account, region: 'ap-northeast-1' } });
const pool = new cognito.UserPool(auth, 'Pool', { removalPolicy: cdk.RemovalPolicy.DESTROY });
pool.addClient('Client');
