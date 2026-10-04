import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const account = '123456789012';

function synth() {
  const app = new cdk.App();
  const stack = new GithubOidcStack(app, 'oidc', {
    env: { account, region: 'ap-northeast-1' },
    envName: 'test',
    subjectPrefix: 'repo:owner@1/repo@2',
    webRegion: 'us-east-1',
  });
  return Template.fromStack(stack);
}

describe('github-oidc', () => {
  const t = synth();

  it('cdkd 用ロールは deploy ロールからだけ引き受けられる', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'sakekasu-learning-cdkd-deploy' },
    });
    const [role] = Object.values(roles);
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Action: 'sts:AssumeRole',
        Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/^DeployRole/), 'Arn'] } },
      }),
    ]);
  });

  it('deploy ロールは cdkd 用ロールを引き受けられる', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AssumeCdkdRole',
            Action: 'sts:AssumeRole',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^CdkdRole'), 'Arn'] },
          }),
        ]),
      },
    });
  });

  it('diff ロールは cdkd の状態のうち、このアプリの分だけを読める', () => {
    const [role] = Object.values(
      t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'sakekasu-learning-github-actions-diff' } }),
    );
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes('DiffRole'),
    );
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s) => [s.Action].flat());
    // 書き込みの権限は持たない
    expect(actions.filter((a: string) => !/:(Get|List|Describe)/.test(a))).toEqual([]);
    const read = statements.find((s) => s.Sid === 'ReadCdkdState');
    expect(read.Resource).toEqual([
      `arn:aws:s3:::cdkd-state-${account}/cdkd/sakekasu-learning-test-*`,
      `arn:aws:s3:::cdkd-state-${account}/cdkd/_index/*`,
      `arn:aws:s3:::cdkd-state-${account}/cdkd-bootstrap/*`,
    ]);
  });

  it('deploy ロールは CDK のブートストラップロールを引き受けない（cdkd 移行後は不要）', () => {
    expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).not.toContain('cdk-hnb659fds');
  });

  describe('cdkd 用ロールのガードレール', () => {
    const guardrail = Object.values(t.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: 'deploy-guardrail' },
    }));
    const statement = (sid: string) =>
      (guardrail[0].Properties.PolicyDocument.Statement as Record<string, unknown>[]).find((s) => s.Sid === sid);

    it('cdkd 用ロールにだけ付き、中身は Deny だけ', () => {
      expect(guardrail).toHaveLength(1);
      expect(guardrail[0].Properties.Roles).toEqual([{ Ref: expect.stringMatching(/^CdkdRole/) }]);
      const statements = guardrail[0].Properties.PolicyDocument.Statement as { Effect: string }[];
      expect(statements.every((s) => s.Effect === 'Deny')).toBe(true);
    });

    it('他のアプリの App タグが付いたリソースと、他のアプリの App タグの付与を拒否する', () => {
      expect(statement('DenyOtherAppsResources')?.Condition).toEqual({
        Null: { 'aws:ResourceTag/App': 'false' },
        StringNotEquals: { 'aws:ResourceTag/App': 'learning' },
      });
      expect(statement('DenyForeignAppTag')?.Condition).toEqual({
        Null: { 'aws:RequestTag/App': 'false' },
        StringNotEquals: { 'aws:RequestTag/App': 'learning' },
      });
    });

    it('IAM ロールは sakekasu-learning- の外では作り替えられず、GitHub Actions のロールは別に守る', () => {
      expect(statement('DenyRolesOutsideApp')?.NotResource).toEqual([
        `arn:aws:iam::${account}:role/sakekasu-learning-*`,
        `arn:aws:iam::${account}:policy/sakekasu-learning-*`,
      ]);
      expect(statement('DenyTamperingWithGithubActionsRoles')?.Resource).toEqual([
        `arn:aws:iam::${account}:role/sakekasu-learning-github-actions-deploy`,
        `arn:aws:iam::${account}:role/sakekasu-learning-cdkd-deploy`,
        `arn:aws:iam::${account}:role/sakekasu-learning-github-actions-diff`,
      ]);
    });

    // Runtime には App タグが無いので、タグの Deny では他のアプリの Runtime を守れない
    it('AgentCore Runtime は sakekasu_learning_ の外では変更・削除できない', () => {
      expect(statement('DenyAgentRuntimesOutsideApp')?.NotResource).toEqual(
        `arn:aws:bedrock-agentcore:*:${account}:runtime/sakekasu_learning_*`,
      );
    });

    it('IAM Identity Center のディレクトリ（sso-directory）にも触れない', () => {
      expect(statement('DenyIdentityAndAccountControl')?.Action).toEqual(
        expect.arrayContaining(['sso:*', 'sso-directory:*', 'identitystore:*']),
      );
    });

    it('他のアプリの cdkd の状態は書き換えられず、自分の状態は対象に入らない', () => {
      const resources = statement('DenyWritingOtherAppsState')?.Resource as string[];
      expect(resources).toContain(`arn:aws:s3:::cdkd-state-${account}/cdkd/sakekasu-kakeibo*`);
      expect(resources.some((r) => r.includes('learning'))).toBe(false);
    });
  });

  it('IAM ロールの description は ASCII だけ（日本語だとデプロイが 400 で落ちる）', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role'));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(role.Properties.Description).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
