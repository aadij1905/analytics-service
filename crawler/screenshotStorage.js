// Screenshot storage backend. Uploads to Cloudflare R2 (S3-compatible) when
// R2 credentials are configured; otherwise falls back to writing local disk
// and serving it via index.js's /screenshots static mount. The fallback
// exists so local dev/testing never needs real cloud credentials — this is
// also what runs today in production if R2 env vars are unset.
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:4000";

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
const useR2 = R2_VARS.every((k) => process.env[k]);

let s3Client = null;
function getClient() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

// Uploads/writes `buffer` under `filename` and returns a public URL.
// Best-effort: a storage failure returns null rather than throwing, so one
// bad upload doesn't waste an otherwise-successful page crawl (CTA text,
// social proof, scroll depth are independent of whether the screenshot saved).
async function saveScreenshot(buffer, filename, outputDir) {
  if (useR2) {
    try {
      const { PutObjectCommand } = require("@aws-sdk/client-s3");
      await getClient().send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: filename,
        Body: buffer,
        ContentType: "image/jpeg",
      }));
      return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${filename}`;
    } catch (err) {
      console.error(`R2 upload failed for ${filename}:`, err.message);
      return null;
    }
  }

  if (!outputDir) return null;
  try {
    require("fs").writeFileSync(`${outputDir}/${filename}`, buffer);
    return `${PUBLIC_URL}/screenshots/${filename}`;
  } catch (err) {
    console.error(`Local screenshot write failed for ${filename}:`, err.message);
    return null;
  }
}

module.exports = { saveScreenshot };
