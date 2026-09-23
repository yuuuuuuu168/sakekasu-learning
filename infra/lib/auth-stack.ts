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
      // MFA は必須。2要素目は認証アプリ（TOTP）だけにする（SMS は従量課金、メールは SES が要るため）。
      // 未登録のユーザーはログイン時に登録を求められる（画面は web/src/auth/AuthGate.tsx）
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: '【sakekasu learning】アカウントを作成しました',
        emailBody:
          `sakekasu learning（${siteUrl}）のアカウントを作成しました。<br><br>` +
          'ユーザー名: {username}<br>仮パスワード: {####}<br><br>' +
          '初回ログイン時に、新しいパスワードの設定と、認証アプリ（Google Authenticator など）の登録を行ってください。<br>' +
          '仮パスワードの有効期限は7日間です。',
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
      // ログイン途中（パスワード変更・認証アプリの登録）のセッションの有効期限。
      // 既定の3分では、認証アプリを入れて QR を読み取るまでに切れやすいため上限の15分にする
      authSessionValidity: Duration.minutes(15),
      enableTokenRevocation: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
