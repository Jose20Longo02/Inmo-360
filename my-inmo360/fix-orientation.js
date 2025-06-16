// fix-orientation.js
require('dotenv').config();
const AWS   = require('aws-sdk');
const sharp = require('sharp');

const endpoint = process.env.SPACES_ENDPOINT;
if (!endpoint) {
  throw new Error('Tienes que definir SPACES_ENDPOINT en .env');
}
const spacesEndpoint = new AWS.Endpoint(endpoint);

const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
});

const BUCKET = process.env.SPACES_BUCKET;
const PREFIX = 'propiedades/';  // ajusta si tus imágenes están bajo otro prefijo

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

async function fixKey(key) {
  if (!/\.(jpe?g|png|webp)$/i.test(key)) return;
  console.log('🔄 Procesando:', key);

  // 1) Descargar
  const { Body } = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();

  // 2) Girar según EXIF y reiniciar metadata de orientación
  const rotatedBuffer = await sharp(Body)
    .rotate()  // corrige la orientación
    .withMetadata({ orientation: 1 })  // reinicia la etiqueta EXIF
    .toBuffer();

  // 3) Detectar content-type
  let contentType = 'application/octet-stream';
  if (/\.png$/i.test(key))       contentType = 'image/png';
  else if (/\.webp$/i.test(key))  contentType = 'image/webp';
  else                             contentType = 'image/jpeg';

  // 4) Volver a subir con CacheControl cero para evitar viejos cachés
  await s3.putObject({
    Bucket:       BUCKET,
    Key:          key,
    Body:         rotatedBuffer,
    ACL:          'public-read',
    ContentType:  contentType,
    CacheControl: 'max-age=0,no-cache'
  }).promise();

  console.log('✅ Listo:', key);
}

(async () => {
  try {
    console.log('▶️  Iniciando reprocesado de orientación...');
    const keys = await listAllKeys();
    for (const key of keys) {
      await fixKey(key);
    }
    console.log('🎉 Todas las imágenes JPG, PNG y WEBP fueron reprocesadas.');
  } catch (err) {
    console.error('❌ Error en reprocesado:', err);
    process.exit(1);
  }
})();