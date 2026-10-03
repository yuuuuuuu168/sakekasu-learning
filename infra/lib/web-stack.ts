import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface WebStackProps extends StackProps {
  envName: string;
  domainName: string;
  /**
   * domainName 用のホストゾーン ID。sakekasu-builder.com の権威ゾーンは管理アカウントにあるため、
   * このアカウントに learning.sakekasu-builder.com のゾーンを手動で作り、親から NS で委任している
   * （sakekasu-kakeibo と同じ方式。手順は README）
   */
  hostedZoneId: string;
  /** API / 認証 / AI チャットのリージョン（CSP の connect-src に使う） */
  backendRegion: string;
  /**
   * 共通ログインのマネージドログインのドメイン（例: auth.sakekasu-builder.com）。
   * ログイン後の認可コードとトークンの交換（/oauth2/token）を画面から fetch するため、CSP の connect-src に入れる
   */
  authDomain: string;
}

/**
 * フロントエンドの配信（S3 + CloudFront + OAC）。
 *
 * CloudFront の証明書は us-east-1 に置く必要があるため、このスタックごと us-east-1 に置く。
 * 東京のスタックの値（API の URL など）は参照しない。フロントは実行時に /config.json を読んで
 * 接続先を知るので、スタック間のリージョンをまたいだ参照（カスタムリソース）が要らない。
 *
 * サイトのファイルは CDK ではなく CI が `aws s3 sync` で置く（BucketDeployment は使わない）。
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { envName, domainName, hostedZoneId, backendRegion, authDomain } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId,
      zoneName: domainName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `sakekasu-learning-${envName}-web-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `sakekasu-learning-${envName}-security-headers`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            [
              "connect-src 'self'",
              `https://*.execute-api.${backendRegion}.amazonaws.com`,
              `https://cognito-idp.${backendRegion}.amazonaws.com`,
              `https://${authDomain}`,
              `https://bedrock-agentcore.${backendRegion}.amazonaws.com`,
            ].join(' '),
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
            override: true,
          },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `sakekasu-learning ${envName}`,
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // SPA のため、存在しないパスは index.html を返してクライアント側でルーティングする
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    new route53.ARecord(this, 'AliasA', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AliasAAAA', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'SiteUrl', { value: `https://${domainName}` });
  }
}
