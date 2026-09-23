import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  envName: string;
  /**
   * OIDC トークンの sub の接頭辞。このリポジトリは GitHub の immutable subject が有効なため、
   * `repo:<owner>@<owner_id>/<repo>@<repo_id>` の形になる（リポジトリ名の変更や同名での
   * 作り直しでは一致しない）。確認: gh api repos/<owner>/<repo>/actions/oidc/customization/sub
   */
  subjectPrefix: string;
  /** CloudFront / ACM を置くリージョン */
  webRegion: string;
}

/**
 * GitHub Actions から AWS を操作するためのロール。
 *
 * OIDC プロバイダはアカウントに1つしか作れず、sakekasu-builder が作成済みなので import する。
 * このスタックは CI 自身の権限を定義するため、手動でデプロイする（-c github-oidc=true）。
 *
 * - deploy: main への push でだけ使える。CDK のブートストラップロールの引き受けと、
 *           サイト・問題データの同期、CloudFront のキャッシュ削除だけを許可する
 * - diff:   PR でだけ使える。cdk diff 用の読み取りロールの引き受けだけを許可する
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const { envName, subjectPrefix, webRegion } = props;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const principal = (sub: string) =>
      new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': sub,
        },
      });

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'sakekasu-learning-github-actions-deploy',
      description: 'GitHub Actions deploy role for sakekasu-learning (main branch only)',
      assumedBy: principal(`${subjectPrefix}:ref:refs/heads/main`),
      maxSessionDuration: Duration.hours(1),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
    const buckets = [
      `sakekasu-learning-${envName}-web-${this.account}`,
      `sakekasu-learning-${envName}-questions-${this.account}`,
    ];
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncBuckets',
        actions: ['s3:ListBucket'],
        resources: buckets.map((b) => `arn:aws:s3:::${b}`),
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncObjects',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: buckets.map((b) => `arn:aws:s3:::${b}/*`),
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateCache',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [this.region, webRegion].map(
          (r) => `arn:aws:cloudformation:${r}:${this.account}:stack/sakekasu-learning-${envName}-*/*`,
        ),
      }),
    );

    const diffRole = new iam.Role(this, 'DiffRole', {
      roleName: 'sakekasu-learning-github-actions-diff',
      description: 'GitHub Actions cdk diff role for sakekasu-learning (pull requests only)',
      assumedBy: principal(`${subjectPrefix}:pull_request`),
      maxSessionDuration: Duration.hours(1),
    });
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeLookupRole',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new CfnOutput(this, 'DiffRoleArn', { value: diffRole.roleArn });
  }
}
