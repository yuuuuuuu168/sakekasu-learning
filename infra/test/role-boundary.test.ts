import { existsSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_DIR, AgentStack } from '../lib/agent-stack';
import { BackendStack } from '../lib/backend-stack';
import { applyRoleBoundary } from '../lib/role-boundary';
import { WebStack } from '../lib/web-stack';

const account = '123456789012';
const sharedAuth = {
  domain: 'auth.example.com',
  userPoolId: 'ap-northeast-1_TestPool1',
  clientId: 'testclientid0123456789abcd',
};

/*
 * bin/app.ts はアプリのスタックすべてに境界を付ける。cdkd 用ロールは境界の無いロールを
 * 作れないので、付け漏れはデプロイの AccessDenied になる
 */
describe('Permissions Boundary', () => {
  let templates: Template[];
  beforeAll(() => {
    if (!existsSync(AGENT_PACKAGE_DIR)) {
      throw new Error('先に npm run package:agent を実行してください');
    }
    const app = new cdk.App();
    const env = { account, region: 'ap-northeast-1' };
    const backend = new BackendStack(app, 'backend', {
      env,
      envName: 'test',
      sharedAuth,
      allowedOrigins: ['https://learning.example.com'],
    });
    const agent = new AgentStack(app, 'agent', {
      env,
      envName: 'test',
      sharedAuth,
      questionsBucket: backend.questionsBucket,
    });
    const web = new WebStack(app, 'web', {
      env: { account, region: 'us-east-1' },
      envName: 'test',
      domainName: 'learning.example.com',
      hostedZoneId: 'Z000TEST',
      backendRegion: 'ap-northeast-1',
      authDomain: sharedAuth.domain,
    });
    for (const stack of [backend, agent, web]) applyRoleBoundary(stack);
    templates = [backend, agent, web].map((stack) => Template.fromStack(stack));
  }, 60_000);

  it('境界を付けたスタックでは、すべてのロールが境界を持つ', () => {
    const roles = templates.flatMap((t) => Object.entries(t.findResources('AWS::IAM::Role')));
    // AgentCore Runtime のロールと API の Lambda のロール
    expect(roles.length).toBeGreaterThanOrEqual(2);
    for (const [id, role] of roles) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary ?? ''), id).toContain(
        ':policy/sakekasu-learning-role-boundary',
      );
    }
  });
});
