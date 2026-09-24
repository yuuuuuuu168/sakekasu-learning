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

  it('IAM ロールの description は ASCII だけ（日本語だとデプロイが 400 で落ちる）', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role'));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(role.Properties.Description).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
