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

  it('diff ロールには回答履歴と問題データを読ませない', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'DenyDataRead', Effect: 'Deny', Action: Match.arrayWith(['dynamodb:Scan']) }),
          Match.objectLike({
            Sid: 'DenyQuestionData',
            Effect: 'Deny',
            Resource: `arn:aws:s3:::sakekasu-learning-test-questions-${account}/*`,
          }),
        ]),
      },
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
