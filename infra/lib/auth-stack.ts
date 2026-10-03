import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  envName: string;
  siteUrl: string;
}

/**
 * 旧ログイン基盤（このアプリ専用のユーザープール）。
 *
 * ログインは共通ログイン（sakekasu-integrated_environment の共通ユーザープール。cdk.json の
 * context `sharedAuth`）に移した。API・エージェント・画面はもうこのスタックを参照しない。
 * 切り戻しと、回答履歴の付け替え（旧 sub を調べる）のために残している（RETAIN・削除保護のまま）。
 * データの付け替えが済んだら、別の PR でこのスタックを外す（手順は docs/shared-login.md）。
 *
 * cdkd で管理しているので、論理 ID を変える変更や、スタックを消す変更はしない。
 *
 * 招待制のため、セルフサインアップは無効にしている。
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
      // 未登録のユーザーはログイン時に登録を求められる（旧画面。いまの画面は共通ログインを使う）
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

    // backend / agent がこのスタックを参照していたころに CDK が自動で作った Export を、同じ名前で残す。
    // 参照をやめると CDK は Export を消そうとするが、CloudFormation と同じく「使用中の Export は消せない」
    // 扱いになる環境でもデプロイが詰まらないよう、まずは残しておく（スタックを外す PR で一緒に消す）
    this.exportValue(this.userPool.userPoolId);
    this.exportValue(this.userPoolClient.userPoolClientId);
  }
}
