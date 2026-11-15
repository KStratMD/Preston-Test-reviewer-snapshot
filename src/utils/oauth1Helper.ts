import crypto from "crypto";

export interface OAuth1Params {
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
  nonce: string;
  timestamp: string;
  signatureMethod?: string;
  version?: string;
  realm?: string;
  /**
   * Additional non-OAuth parameters that should be included in the signature base string.
   * Useful for cases like oauth_body_hash when required.
   */
  extraParams?: Record<string, string | undefined>;
}

const encode = (value: string): string => encodeURIComponent(value);

const resolveHashAlgorithm = (signatureMethod?: string): "sha256" | "sha1" => {
  if (!signatureMethod) {
    return "sha256";
  }
  return signatureMethod.toUpperCase() === "HMAC-SHA1" ? "sha1" : "sha256";
};

const buildParameterString = (
  url: URL,
  oauthParams: Record<string, string>,
  extraParams?: Record<string, string | undefined>,
): string => {
  const allParams: [string, string][] = [];

  for (const [key, value] of Object.entries(oauthParams)) {
    allParams.push([key, value]);
  }

  for (const [key, value] of url.searchParams) {
    allParams.push([key, value]);
  }

  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value === undefined) {
        continue;
      }
      allParams.push([key, value]);
    }
  }

  return allParams
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .sort()
    .join("&");
};

export function generateOAuth1Signature(
  method: string,
  fullUrl: string,
  params: OAuth1Params,
  body?: string,
): string {
  const signatureMethod = params.signatureMethod ?? "HMAC-SHA256";
  const version = params.version ?? "1.0";
  const url = new URL(fullUrl);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: params.nonce,
    oauth_signature_method: signatureMethod,
    oauth_timestamp: params.timestamp,
    oauth_token: params.tokenId,
    oauth_version: version,
  };

  const parameterString = buildParameterString(url, oauthParams, params.extraParams);
  const baseUrl = `${url.origin}${url.pathname}`;

  const signatureBaseString = [
    method.toUpperCase(),
    encode(baseUrl),
    encode(parameterString),
  ].join("&");

  const signingKey = `${encode(params.consumerSecret)}&${encode(params.tokenSecret)}`;
  const hashAlgorithm = resolveHashAlgorithm(signatureMethod);

  const hmac = crypto.createHmac(hashAlgorithm, signingKey);
  if (body && body.length > 0 && signatureMethod.toUpperCase() === "HMAC-SHA256") {
    // For JSON payloads NetSuite does not require the body to be part of the signature.
    // The branch remains for parity with potential future oauth_body_hash support.
  }

  return hmac.update(signatureBaseString).digest("base64");
}

export function getOAuth1AuthorizationHeader(
  method: string,
  fullUrl: string,
  params: OAuth1Params,
  body?: string,
): string {
  const signatureMethod = params.signatureMethod ?? "HMAC-SHA256";
  const version = params.version ?? "1.0";
  const timestamp = params.timestamp;
  const nonce = params.nonce;

  const signature = generateOAuth1Signature(method, fullUrl, params, body);

  const headerParts: string[] = [];
  if (params.realm) {
    headerParts.push(`realm="${encode(params.realm)}"`);
  }

  headerParts.push(
    `oauth_consumer_key="${encode(params.consumerKey)}"`,
    `oauth_token="${encode(params.tokenId)}"`,
    `oauth_signature_method="${encode(signatureMethod)}"`,
    `oauth_timestamp="${encode(timestamp)}"`,
    `oauth_nonce="${encode(nonce)}"`,
    `oauth_version="${encode(version)}"`,
    `oauth_signature="${encode(signature)}"`,
  );

  return `OAuth ${headerParts.join(", ")}`;
}
