import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { deployGuardrailStatements } from './deploy-guardrail';
import { createRoleBoundary, roleBoundaryArn } from './role-boundary';

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
 * - deploy: main への push でだけ使える。cdkd 用ロールの引き受けと、
 *           サイト・問題データの同期、CloudFront のキャッシュ削除だけを許可する
 * - cdkd:   deploy ロールからだけ引き受けられる。cdkd は CloudFormation を通さず各サービスの API を
 *           直接呼ぶため、デプロイするリソースすべての権限が要る。CDK の cfn-exec ロールと同じく管理者権限。
 *           その上に、他のアプリのリソースに触れないためのガードレール（Deny だけ。deploy-guardrail.ts）を重ねる
 * - diff:   PR でだけ使える。cdkd diff 用に、このアプリの cdkd の状態だけを読める（AWS のリソースやデータは読めない）
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
    const cdkdRole = new iam.Role(this, 'CdkdRole', {
      roleName: 'sakekasu-learning-cdkd-deploy',
      description: 'cdkd deploy role for sakekasu-learning (assumed only by the GitHub Actions deploy role)',
      assumedBy: new iam.ArnPrincipal(deployRole.roleArn),
      maxSessionDuration: Duration.hours(1),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });
    // アプリのロールに付ける Permissions Boundary。cdkd に作らせると、cdkd 自身が境界を
    // 書き換えて外せてしまうので、このスタックで作る（理由は role-boundary.ts）
    createRoleBoundary(this, 'RoleBoundary');

    new iam.Policy(this, 'CdkdGuardrail', {
      policyName: 'deploy-guardrail',
      roles: [cdkdRole],
      statements: deployGuardrailStatements({
        account: this.account,
        app: 'learning',
        resourceNamePrefixes: ['sakekasu-learning-'],
        // agent-stack.ts の agentRuntimeName（sakekasu_learning_<env>_tutor）。Runtime の名前は _ しか使えない
        agentRuntimeNamePrefix: 'sakekasu_learning_',
        protectedRoleNames: [
          'sakekasu-learning-github-actions-deploy',
          'sakekasu-learning-cdkd-deploy',
          'sakekasu-learning-github-actions-diff',
        ],
        roleBoundaryArn: roleBoundaryArn(this.account),
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkdRole',
        actions: ['sts:AssumeRole'],
        resources: [cdkdRole.roleArn],
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
        // 移行スクリプト（cdkd-stacks.sh migrate）用。移行が済み deploy からは呼ばなくなったので、
        // 次に IAM を変えるときに外してよい（読み取りだけなので残しても害は無い）
        sid: 'ReadStacks',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources'],
        resources: [this.region, webRegion].map(
          (r) => `arn:aws:cloudformation:${r}:${this.account}:stack/sakekasu-learning-${envName}-*/*`,
        ),
      }),
    );

    const diffRole = new iam.Role(this, 'DiffRole', {
      roleName: 'sakekasu-learning-github-actions-diff',
      description: 'GitHub Actions diff role for sakekasu-learning (pull requests only)',
      assumedBy: principal(`${subjectPrefix}:pull_request`),
      maxSessionDuration: Duration.hours(1),
    });
    // cdkd diff が読むのは、このアプリのスタックの状態と、スタック間参照の索引・資産置き場の目印だけ。
    // 状態バケットは同じアカウントの別プロジェクトと共有しているので、読めるキーをこのアプリの分に絞る。
    // 次の 2 つは承知の上で残している（どちらもアカウントの持ち主は同じで、中身は ARN や ID、バケット名）
    // - ListBucket: s3:prefix で絞ると、cdkd が状態バケットの確認に使う HeadBucket（接頭辞なし）も拒否される。
    //   別プロジェクトのキー名（スタック名）は見える
    // - _index / cdkd-bootstrap: cdkd がアカウントで共有する索引（Export の値）と資産置き場の目印。
    //   このアプリは Fn::ImportValue を使うので、diff で索引を読む必要がある
    const stateBucket = `cdkd-state-${this.account}`;
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListCdkdState',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [`arn:aws:s3:::${stateBucket}`],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        // cdkd は資産置き場のバケットが自分のアカウントのものかを HeadBucket で確かめる（ListBucket の権限で判定される）
        sid: 'CheckCdkdAssets',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [`arn:aws:s3:::cdkd-assets-${this.account}-*`],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        // 同じ確認で、コンテナ資産の置き場（ECR）があるかも見る
        sid: 'CheckCdkdContainerAssets',
        actions: ['ecr:DescribeRepositories'],
        resources: [`arn:aws:ecr:*:${this.account}:repository/cdkd-container-assets-${this.account}-*`],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        // 変更が置き換え（作り直し）になるかを、公開されているリソース型のスキーマから判定する
        sid: 'ReadResourceSchemas',
        actions: ['cloudformation:DescribeType'],
        resources: ['arn:aws:cloudformation:*::type/resource/*'],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        // Fn::GetAtt [Distribution, DomainName] は CloudFront から読んで解決する。読めないと Route 53 の
        // レコードに実際には無い変更が出る
        sid: 'ResolveDistributionDomain',
        actions: ['cloudfront:GetDistribution'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCdkdState',
        actions: ['s3:GetObject'],
        resources: [
          `arn:aws:s3:::${stateBucket}/cdkd/sakekasu-learning-${envName}-*`,
          `arn:aws:s3:::${stateBucket}/cdkd/_index/*`,
          `arn:aws:s3:::${stateBucket}/cdkd-bootstrap/*`,
        ],
      }),
    );
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        // 移行スクリプトが CloudFormation のスタックが残っているかを確かめる
        sid: 'ReadStacks',
        actions: ['cloudformation:DescribeStacks'],
        resources: [this.region, webRegion].map(
          (r) => `arn:aws:cloudformation:${r}:${this.account}:stack/sakekasu-learning-${envName}-*/*`,
        ),
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new CfnOutput(this, 'DiffRoleArn', { value: diffRole.roleArn });
    new CfnOutput(this, 'CdkdRoleArn', { value: cdkdRole.roleArn });
  }
}
