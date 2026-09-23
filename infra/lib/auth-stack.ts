import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  envName: string;
  siteUrl: string;
}

/**
 * ログイン基盤。招待制のため、セルフサインアップは無効にする。
 * ユーザーは管理者が admin-create-user で作成し、初回ログイン時にパスワードを変更してもらう。
 * （AI チャットは従量課金なので、誰でも登録できる状態にはしない）
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { envName, siteUrl } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${envName}-sakekasu-learning-userpool`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      // ログイン画面は自前（パスワード + 初回変更 + 再設定）のみ。MFA を足すなら画面も対応させる
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: '【sakekasu learning】アカウントを作成しました',
        emailBody:
          `sakekasu learning（${siteUrl}）のアカウントを作成しました。<br><br>` +
          'ユーザー名: {username}<br>仮パスワード: {####}<br><br>' +
          '初回ログイン時に新しいパスワードを設定してください。仮パスワードの有効期限は7日間です。',
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${envName}-sakekasu-learning-web`,
      authFlows: { userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
