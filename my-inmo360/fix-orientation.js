// fix-orientation.js
require('dotenv').config();
const AWS   = require('aws-sdk');
const sharp = require('sharp');

// ① Lee el endpoint desde .env y valida
const endpoint = process.env.SPACES_ENDPOINT;
if (!endpoint) {
  throw new Error('Tienes que definir SPACES_ENDPOINT en .env');
}
const spacesEndpoint = new AWS.Endpoint(endpoint);

// ② Configura el cliente S3 apuntando a DigitalOcean Spaces
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
});

// ③ Bucket y prefijo donde están tus imágenes
const BUCKET = process.env.SPACES_BUCKET;
const PREFIX = 'propiedades/';  // ajusta si usas otra carpeta

/**
 * Lista recursivamente todas las keys bajo el prefijo dado.
 */
async function listAllKeys(token = null, acc = []) {
  const params = { Bucket: BUCKET, Prefix: PREFIX };
  if (token) params.ContinuationToken = token;
  const resp = await s3.listObjectsV2(params).promise();
  acc.push(...resp.Contents.map(o => o.Key));
  if (resp.IsTruncated) {
    return listAllKeys(resp.NextContinuationToken, acc);
  }
  return acc;
}

/**
 * Procesa un solo objeto:
 * 1) rota según EXIF
 * 2) re-subir JPG/PNG corregido
 * 3) regenerar y subir sus versiones WebP (300px y 600px)
 */
async function fixKey(key) {
  // solo interesa JPG, PNG o WEBP (pero regeneramos WebP desde JPG/PNG)
  if (!/\.(jpe?g|png|webp)$/i.test(key)) return;
  console.log('🔄 Procesando:', key);

  // 1) Descarga el objeto
  const { Body } = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();

  // 2) Rota según EXIF y resetea metadata
  const image = sharp(Body).rotate();
  const rotatedBuffer = await image
    .withMetadata({ orientation: 1 })
    .toBuffer();

  // 3) Determina content-type
  let contentType = 'application/octet-stream';
  if (/\.png$/i.test(key))       contentType = 'image/png';
  else if (/\.jpe?g$/i.test(key)) contentType = 'image/jpeg';
  else if (/\.webp$/i.test(key))  contentType = 'image/webp';

  // 4) Re-subir el original corregido
  await s3.putObject({
    Bucket:       BUCKET,
    Key:          key,
    Body:         rotatedBuffer,
    ACL:          'public-read',
    ContentType:  contentType,
    CacheControl: 'max-age=0,no-cache'
  }).promise();
  console.log('✅ JPG/PNG rotado:', key);

  // 5) Si el key es JPG o PNG, regenerar sus WebP
  if (/\.(jpe?g|png)$/i.test(key)) {
    const widths = [300, 600];
    for (const w of widths) {
      const webpBuf = await image
        .clone()                      // clona la instancia ya rotada
        .resize({ width: w, withoutEnlargement: true })
        .toFormat('webp', { quality: 80 })
        .toBuffer();

      const webpKey = key.replace(/\.(jpe?g|png)$/i, `_${w}.webp`);
      await s3.putObject({
        Bucket:       BUCKET,
        Key:          webpKey,
        Body:         webpBuf,
        ACL:          'public-read',
        ContentType:  'image/webp',
        CacheControl: 'max-age=0,no-cache'
      }).promise();
      console.log(`✅ Regenerada WebP (${w}px):`, webpKey);
    }
  }
}

(async () => {
  try {
    console.log('▶️  Iniciando reprocesado de orientación y regeneración de WebP...');
    const keys = await listAllKeys();
    for (const key of keys) {
      await fixKey(key);
    }
    console.log('🎉 Proceso completado: todos los JPG/PNG rotados y WebP regeneradas.');
  } catch (err) {
    console.error('❌ Error en reprocesado:', err);
    process.exit(1);
  }
})();