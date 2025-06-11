// server.js
const multer = require('multer');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const pool = require('./db');
const methodOverride = require('method-override');
const locationsData = require('./locations');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const { departamentos } = locationsData;
const compression = require('compression');
const fs = require('fs-extra'); // <- Asegúrate de instalarlo: npm install fs-extra

const app = express();
const PORT = process.env.PORT || 3000;

const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'inmo360.notifications@gmail.com',       // tu cuenta de Gmail
    pass: 'cpts gulr dkbe urou'           // la contraseña de aplicación generada
  }
});

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
app.use(compression());

// Configuración de EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'mi_secreto',
  resave: false,
  saveUninitialized: false
}));

// Pasar información del usuario a las vistas
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// =========================
// CONFIGURACIÓN MULTER
// =========================

// Ahora aceptamos videos en el campo 'video' además de imágenes en los demás.
function fileFilter(req, file, cb) {
  if (file.fieldname === 'video') {
    // dejamos pasar cualquier tipo de video
    cb(null, true);
  } else if (file.mimetype.startsWith('image/')) {
    // imágenes válidas
    cb(null, true);
  } else {
    cb(new Error('Formato no soportado: solo imágenes o video'), false);
  }
}

const limits = { fileSize: 30 * 1024 * 1024 };

// Middleware de subida en memoria (para procesar buffer antes de subir a Spaces)
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits,
});

// 2) Cliente S3 v2 para DigitalOcean Spaces
const spacesEndpoint = new AWS.Endpoint(process.env.SPACES_ENDPOINT);
const s3v2 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
});
console.log('⛅ SPACES_BUCKET:', process.env.SPACES_BUCKET);
console.log('⛅ SPACES_ENDPOINT:', process.env.SPACES_ENDPOINT);

// Helper para generar key en Spaces
function makeS3Key(prefixFolder, originalName) {
  const timestamp = Date.now();
  const baseName = path.basename(originalName).replace(/\s+/g, '_');
  return `${prefixFolder}/${timestamp}-${baseName}`;
}

// Middleware de subida directa a Spaces/S3 con multer-s3
const uploadS3 = multer({
  storage: multerS3({
    s3: s3v2,
    bucket: process.env.SPACES_BUCKET,
    acl: 'public-read',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      let prefix;
      if (req.uploadFolderUuid) {
        prefix = `propiedades/${req.uploadFolderUuid}`;
      } else if (req.session && req.session.user) {
        const userUuid = req.session.user.uuid || `user-${req.session.user.id}`;
        prefix = `usuarios/${userUuid}`;
      } else {
        prefix = `temp`;
      }
      cb(null, makeS3Key(prefix, file.originalname));
    }
  }),
  fileFilter,
  limits,
});








// Función para subir un buffer a Spaces usando s3v2, generando variantes WebP
// Función actualizada para subir un buffer a Spaces usando s3v2
async function processAndUploadToSpacesBuffer(buffer, originalName, userUuid, fieldName) {
  const ext = path.extname(originalName).toLowerCase();
  let finalBuffer = buffer;
  let finalExt = ext;
  // convertir HEIC a JPEG si aplica
  if (ext === '.heic' || ext === '.heif') {
    try {
      finalBuffer = await heicConvert({ buffer, format: 'JPEG', quality: 1 });
      finalExt = '.jpg';
    } catch (err) {
      console.error('Error conversión HEIC:', err);
    }
  }

  const timestamp = Date.now();
  let filenameBase;
  if (fieldName === 'profilePic') filenameBase = `profile-${timestamp}`;
  else if (fieldName === 'idFront') filenameBase = `idFront-${timestamp}`;
  else if (fieldName === 'idBack')  filenameBase = `idBack-${timestamp}`;
  else filenameBase = `${timestamp}`;

  const bucket = process.env.SPACES_BUCKET;
  if (!bucket) throw new Error('SPACES_BUCKET no definido');

  // 1) Sube la original
  const keyOriginal = `usuarios/${userUuid}/${filenameBase}${finalExt}`;
  await s3v2.putObject({
    Bucket: bucket,
    Key: keyOriginal,
    Body: finalBuffer,
    ACL: 'public-read',
    ContentType: `image/${finalExt.replace(/^\./,'')}`
  }).promise();

  // 2) Genera y sube las versiones WebP a 300px y 600px
  const widths = [300, 600];
  await Promise.all(widths.map(async w => {
    const bufW = await sharp(finalBuffer)
      .resize({ width: w, withoutEnlargement: true })
      .toFormat('webp', { quality: 80 })
      .toBuffer();
    const keyWebp = `usuarios/${userUuid}/${filenameBase}_${w}.webp`;
    await s3v2.putObject({
      Bucket: bucket,
      Key: keyWebp,
      Body: bufW,
      ACL: 'public-read',
      ContentType: 'image/webp'
    }).promise();
  }));

  // 3) Devuelve la URL de la original para seguir utilizándola en tu app
  return `https://${bucket}.${process.env.SPACES_ENDPOINT}/${keyOriginal}`;
}

async function deleteFromSpacesByUrl(url) {
  try {
    const bucketName = process.env.SPACES_BUCKET;
    if (!bucketName) {
      console.warn('SPACES_BUCKET no está definido, no se puede borrar en Spaces.');
      return;
    }
    const prefix = `https://${bucketName}.${process.env.SPACES_ENDPOINT}/`;
    if (!url.startsWith(prefix)) {
      console.warn('URL no pertenece a este Space, se omite borrado en Spaces:', url);
      return;
    }
    const key = url.substring(prefix.length);
    console.log(`⛅ Borrando de Spaces: bucket=${bucketName}, key=${key}`);
    await s3v2.deleteObject({
      Bucket: bucketName,
      Key: key
    }).promise();
  } catch (err) {
    console.error('Error borrando en Spaces:', err);
  }
}

// Ejemplo de borrado local de un fichero previo (en tu ruta de actualizar perfil):
function deleteLocalFileIfExists(localPath) {
  if (fs.existsSync(localPath)) {
    try {
      fs.unlinkSync(localPath);
      console.log('✅ Archivo local eliminado:', localPath);
    } catch (err) {
      console.error('Error eliminando archivo local:', err);
    }
  } else {
    console.warn('Archivo local no encontrado para borrar:', localPath);
  }
}






app.get('/owners', (req, res) => {
  res.render('owners');
});

app.get('/agencies', (req, res) => {
  res.render('agencies');
});

app.get('/search-agencies', async (req, res) => {
  try {
    // Suponemos que tienes locationsData.departamentos cargado
    // para mostrar la lista de departamentos
    const departamentos = locationsData.departamentos;
    res.render('searchAgencies', {
      departamentos,
      query: {},        // Inicialmente sin filtros
      results: []       // Sin resultados al cargar por primera vez
    });
  } catch (err) {
    console.error('Error cargando página de inmobiliarias:', err);
    res.status(500).send('Error al cargar la página');
  }
});

// POST /agencies — Procesar búsqueda de inmobiliarias
app.post('/search-agencies', async (req, res) => {
  const { departamento, municipio } = req.body;
  try {
    // 1) Filtrar según los campos que vengan (departamento y/o municipio)
    let sql = `SELECT id, name, email, phone, departamento, municipio, logo_url 
               FROM inmobiliarias 
               WHERE estado = 'aprobada'`;
    const params = [];

    if (departamento) {
      params.push(departamento);
      sql += ` AND departamento = $${params.length}`;
    }
    if (municipio && municipio.trim() !== "") {
      params.push(municipio);
      sql += ` AND municipio = $${params.length}`;
    }

    // 2) Ejecutar consulta
    const result = await pool.query(sql, params);
    const agenciasEncontradas = result.rows;

    // 3) Renderizar de nuevo la misma vista con resultados
    const departamentos = locationsData.departamentos;
    res.render('searchAgencies', {
      departamentos,
      query: { departamento, municipio },
      results: agenciasEncontradas
    });
  } catch (err) {
    console.error('Error buscando inmobiliarias:', err);
    res.status(500).send('Error al buscar inmobiliarias');
  }
});

// DELETE o comenta la ruta antigua que apuntaba a "agencyDetails".
// Agrega en su lugar esta ruta:

app.get('/buscar-inmobiliaria/:nombre', async (req, res) => {
  const agenciaNombre = req.params.nombre;
  const page          = parseInt(req.query.page, 10) || 1;
  const limit         = 6;
  const offset        = (page - 1) * limit;

  try {
    // 1) Obtener datos de la inmobiliaria por su nombre (suponiendo único)
    const agenciaRes = await pool.query(
      `SELECT id, name, email, phone, address, departamento, municipio, logo_url, estado
         FROM inmobiliarias
        WHERE name = $1
          AND estado = 'aprobada'`,
      [agenciaNombre]
    );
    if (agenciaRes.rows.length === 0) {
      return res.status(404).send('Inmobiliaria no encontrada');
    }
    const agency = agenciaRes.rows[0];
    const agencyId = agency.id;

    // 2) Obtener agentes de esta inmobiliaria
    const agentsRes = await pool.query(
      `SELECT id, username, profile_pic
         FROM users
        WHERE belongs_to_agency = true
          AND agency_id = $1`,
      [agencyId]
    );
    const agents = agentsRes.rows;

    // 3) Contar propiedades aprobadas de la agencia
    const countRes = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM propiedades p
         JOIN users u ON p.user_id = u.id
        WHERE u.agency_id = $1
          AND p.estado = 'aprobada'`,
      [agencyId]
    );
    const totalProps = parseInt(countRes.rows[0].cnt, 10);

    // 4) Traer las propiedades paginadas
    const propsRes = await pool.query(
      `SELECT
          p.id,
          p.titulo,
          p.departamento,
          p.municipio,
          p.zona,
          p.operacion,
          p.precio,
          p.imagenes_urls,
          p.created_at
         FROM propiedades p
         JOIN users u ON p.user_id = u.id
        WHERE u.agency_id = $1
          AND p.estado = 'aprobada'
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [agencyId, limit, offset]
    );
    const propiedades = propsRes.rows;

    // 5) Calcular total de páginas
    const totalPages = Math.ceil(totalProps / limit);

    // 6) Renderizar la nueva vista "agencyProfile"
    res.render('agencyProfile', {
      agency,
      agents,
      propiedades,
      currentPage: page,
      totalPages,
      totalProps
    });
  } catch (err) {
    console.error('Error cargando detalle de inmobiliaria:', err);
    res.status(500).send('Error al cargar detalle de la inmobiliaria');
  }
});


// Middleware de autenticación
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.rol === 'admin') {
    next();
  } else {
    res.status(403).send('Acceso denegado');
  }
}

// Función para mezclar un arreglo (shuffle)
function shuffle(array) {
  let currentIndex = array.length, temporaryValue, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }
  return array;
}


app.get('/admin', requireAdmin, async (req, res) => {
  try {
    // contar inmobiliarias y propiedades pendientes
    const agenciesRes   = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM inmobiliarias
        WHERE estado = 'pendiente'`
    );
    const propertiesRes = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM propiedades
        WHERE estado = 'pendiente'`
    );

    const pendingAgencies   = parseInt(agenciesRes.rows[0].cnt, 10);
    const pendingProperties = parseInt(propertiesRes.rows[0].cnt, 10);

    res.render('admin', {
      pendingAgencies,
      pendingProperties
    });
  } catch (err) {
    console.error('Error cargando panel de admin:', err);
    res.status(500).send('Error cargando panel de administración');
  }
});

// GET /admin/agencies — muestra todas las solicitudes pendientes
app.get('/admin/agencies', isAuthenticated, async (req, res) => {
  try {
    const { rows: agencies } = await pool.query(
      `SELECT 
         id,
         name,
         email,
         phone,
         address,
         departamento,
         municipio,
         logo_url,
         estado,
         created_at,
         created_by,
         solicitante_nombre,
         solicitante_puesto,
         solicitante_email,
         solicitante_telefono,
         motivo_rechazo
       FROM inmobiliarias
       WHERE estado = 'pendiente'
       ORDER BY created_at DESC`
    );
    res.render('adminAgencies', { agencies });
  } catch (err) {
    console.error('Error al cargar inmobiliarias pendientes:', err);
    res.status(500).send('Error interno del servidor');
  }
});

// Asegúrate de tener definido al inicio de tu server.js:
// const nodemailer = require('nodemailer');
// const transporter = nodemailer.createTransport({ /* tu configuración SMTP */ });



app.post('/admin/agencies/:id/aprobar', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  try {
    // 1) Recuperar datos de la agencia
    const agRes = await pool.query(
      'SELECT created_by, name FROM inmobiliarias WHERE id = $1',
      [id]
    );
    const agency = agRes.rows[0];
    if (!agency) {
      return res.status(404).send('Inmobiliaria no encontrada');
    }

    // 2) Marcar como aprobada
    await pool.query(
      "UPDATE inmobiliarias SET estado = 'aprobada' WHERE id = $1",
      [id]
    );

    // 3) Asociar automáticamente al usuario creador
    await pool.query(
      `UPDATE users u
         SET belongs_to_agency = TRUE,
             agency_id         = $1
        FROM inmobiliarias i
       WHERE i.id = $1
         AND u.id = i.created_by`,
      [id]
    );

    // 4) Crear notificación interna
    await pool.query(
      `INSERT INTO notifications (user_id, message, link)
       VALUES ($1, $2, $3)`,
      [
        agency.created_by,
        `Tu inmobiliaria “${agency.name}” ha sido aprobada.`,
        `/inmobiliaria/${id}`
      ]
    );

    // 5) (Opcional) Enviar correo de notificación
    const userEmailRes = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [agency.created_by]
    );
    const userEmail = userEmailRes.rows[0]?.email;
    if (userEmail) {
      await transporter.sendMail({
        from: "Inmo360 <no-reply@inmo360.com>",
        to: userEmail,
        subject: 'Tu inmobiliaria ha sido aprobada',
        text: `¡Felicidades! Tu inmobiliaria “${agency.name}” ya está activa en la plataforma.\n\nSaludos Cordiales\nEquipo Inmo360.`
      });
    }

    res.redirect('/admin/agencies');
  } catch (err) {
    console.error('Error al aprobar inmobiliaria:', err);
    res.status(500).send('Error al aprobar');
  }
});

app.post('/admin/agencies/:id/rechazar', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  try {
    // 1) Recuperar datos de la agencia
    const agRes = await pool.query(
      'SELECT created_by, name, logo_url FROM inmobiliarias WHERE id = $1',
      [id]
    );
    const agency = agRes.rows[0];
    if (!agency) {
      return res.status(404).send('Inmobiliaria no encontrada');
    }

    // 2) Borrar archivo de logo en Spaces si existe
    if (agency.logo_url) {
      // Helper inline para extraer el key de Spaces desde la URL pública
      const extractKeyFromUrl = (url) => {
        if (!url) return null;
        const prefix = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/`;
        if (url.startsWith(prefix)) {
          return url.substring(prefix.length);
        }
        // Si la URL no coincide con el patrón esperado, no borramos
        console.warn('URL de logo no pertenece a este Space, se omite borrado:', url);
        return null;
      };

      const key = extractKeyFromUrl(agency.logo_url);
      if (key) {
        try {
          await s3v2.deleteObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: key
          }).promise();
        } catch (delErr) {
          console.error('Error borrando logo en Spaces:', key, delErr);
        }
      }
    }

    // 3) Eliminar la inmobiliaria de la BD
    await pool.query(
      `DELETE FROM inmobiliarias
         WHERE id = $1`,
      [id]
    );

    // 4) Crear notificación interna al usuario creador
    await pool.query(
      `INSERT INTO notifications (user_id, message, link)
       VALUES ($1, $2, $3)`,
      [
        agency.created_by,
        `Tu inmobiliaria “${agency.name}” fue rechazada. Motivo: ${motivo}. Por favor, vuelve a completar el formulario.`,
        '/agencias/registro'
      ]
    );

    // 5) Enviar correo de notificación
    const userEmailRes = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [agency.created_by]
    );
    const userEmail = userEmailRes.rows[0]?.email;
    if (userEmail) {
      await transporter.sendMail({
        from: 'Inmo360 <no-reply@inmo360.com>',
        to: userEmail,
        subject: 'Tu inmobiliaria ha sido rechazada',
        text: `Lo sentimos, tu inmobiliaria “${agency.name}” fue rechazada por el siguiente motivo:\n\n${motivo}\n\nPor favor, vuelve a completar el formulario.\n\nSaludos cordiales\nEquipo Inmo360`
      });
    }

    res.redirect('/admin/agencies');
  } catch (err) {
    console.error('Error al rechazar inmobiliaria:', err);
    res.status(500).send('Error al rechazar');
  }
});

// Sólo accesible a administradores
// Sólo accesible a administradores
// Sólo accesible a administradores
// Sólo accesible a administradores
app.get('/admin/properties', requireAdmin, async (req, res) => {
  try {
    const { rows: pendientes } = await pool.query(`
      SELECT
        p.id,
        p.titulo,
        p.tipo_propiedad,
        p.departamento,
        p.municipio,
        p.created_at,
        p.descripcion,
        p.imagenes_urls,
        p.video_url,
        p.plano_url,
        p.habitaciones,
        p.banos,
        p.m2_construccion,
        p.m2_terreno,
        p.tamano_terreno,
        p.metros_frente,
        p.caracteristicas_terreno,
        p.bodega_tamano,
        p.bodega_altura,
        p.cantidad_oficinas,
        p.cantidad_banos,
        p.local_tamano,
        p.caracteristicas,
        p.luxury_features,
        p.luxo,
        -- Datos del anunciante
        u.username       AS user_name,
        u.profile_pic    AS user_profile_pic,
        u.email          AS user_email,
        u.phone          AS user_phone,
        u.belongs_to_agency,
        a.name           AS agency_name
      FROM propiedades p
      LEFT JOIN users u        ON p.user_id    = u.id
      LEFT JOIN inmobiliarias a ON u.agency_id  = a.id
      WHERE p.estado = 'pendiente'
      ORDER BY p.created_at DESC
    `);
    res.render('adminProperties', { pendientes });
  } catch (err) {
    console.error('Error cargando propiedades pendientes:', err);
    res.status(500).send('Error interno');
  }
});

// Aprobar propiedad
app.post('/admin/properties/:id/aprobar', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // 1) Recuperar datos de la propiedad
    const propRes = await pool.query(
      `SELECT user_id, titulo 
         FROM propiedades 
        WHERE id = $1`,
      [id]
    );
    const prop = propRes.rows[0];
    if (!prop) {
      return res.status(404).send('Propiedad no encontrada');
    }

    // 2) Marcar como aprobada
    await pool.query(
      `UPDATE propiedades 
         SET estado = 'aprobada' 
       WHERE id = $1`,
      [id]
    );

    // 3) Crear notificación interna
    await pool.query(
      `INSERT INTO notifications (user_id, message, link)
       VALUES ($1, $2, $3)`,
      [
        prop.user_id,
        `Tu propiedad “${prop.titulo}” ha sido aprobada.`,
        `/properties/${id}`
      ]
    );

    // 4) Enviar correo de notificación
    const userEmailRes = await pool.query(
      `SELECT email 
         FROM users 
        WHERE id = $1`,
      [prop.user_id]
    );
    const userEmail = userEmailRes.rows[0]?.email;
    if (userEmail) {
      await transporter.sendMail({
        from: `"Inmo360" <no-reply@tu-dominio.com>`,
        to: userEmail,
        subject: 'Tu propiedad ha sido aprobada',
        text: `¡Buen trabajo! Tu propiedad “${prop.titulo}” ya está activa en la plataforma.\n\nSaludos cordiales,\nEquipo Inmo360.`
      });
    }

    res.redirect('/admin/properties');
  } catch (err) {
    console.error('Error al aprobar propiedad:', err);
    res.status(500).send('Error interno');
  }
});

// Rechazar propiedad
// Rechazar (y eliminar) propiedad
app.post('/admin/properties/:id/rechazar', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  try {
    // 1) Recuperar datos de la propiedad, incluyendo URLs multimedia y folder_uuid
    const propRes = await pool.query(
      `SELECT user_id, titulo, folder_uuid, imagenes_urls, video_url, plano_url
         FROM propiedades
        WHERE id = $1`,
      [id]
    );
    const prop = propRes.rows[0];
    if (!prop) {
      return res.status(404).send('Propiedad no encontrada');
    }

    // 2) Borrar archivos en Spaces si existen
    // Helper para extraer key de Spaces desde URL pública
    const extractKeyFromUrl = (url) => {
      if (!url) return null;
      const prefix = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/`;
      if (url.startsWith(prefix)) {
        return url.substring(prefix.length);
      }
      console.warn('URL no pertenece a este Space, se omite borrado:', url);
      return null;
    };

    // a) Borrar imágenes
    if (prop.imagenes_urls) {
      let images = [];
      if (typeof prop.imagenes_urls === 'string') {
        try {
          images = JSON.parse(prop.imagenes_urls);
        } catch (e) {
          console.warn('JSON inválido en imagenes_urls:', prop.imagenes_urls);
        }
      } else if (Array.isArray(prop.imagenes_urls)) {
        images = prop.imagenes_urls;
      }
      for (const url of images) {
        const key = extractKeyFromUrl(url);
        if (key) {
          try {
            await s3v2.deleteObject({
              Bucket: process.env.SPACES_BUCKET,
              Key: key
            }).promise();
          } catch (e) {
            console.error('Error borrando imagen en Spaces:', key, e);
          }
        }
      }
    }

    // b) Borrar video
    if (prop.video_url) {
      const keyVid = extractKeyFromUrl(prop.video_url);
      if (keyVid) {
        try {
          await s3v2.deleteObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: keyVid
          }).promise();
        } catch (e) {
          console.error('Error borrando video en Spaces:', keyVid, e);
        }
      }
    }

    // c) Borrar plano
    if (prop.plano_url) {
      const keyPlano = extractKeyFromUrl(prop.plano_url);
      if (keyPlano) {
        try {
          await s3v2.deleteObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: keyPlano
          }).promise();
        } catch (e) {
          console.error('Error borrando plano en Spaces:', keyPlano, e);
        }
      }
    }

    // d) (Opcional) Borrar cualquier otro archivo bajo el prefijo folder_uuid
    if (prop.folder_uuid) {
      const prefix = `propiedades/${prop.folder_uuid}/`;
      // Lista todos los objetos bajo este prefijo y los borra en lote
      try {
        let ContinuationToken = null;
        do {
          const listParams = {
            Bucket: process.env.SPACES_BUCKET,
            Prefix: prefix,
            ContinuationToken
          };
          const listed = await s3v2.listObjectsV2(listParams).promise();
          if (listed.Contents && listed.Contents.length > 0) {
            const deleteParams = {
              Bucket: process.env.SPACES_BUCKET,
              Delete: {
                Objects: listed.Contents.map(obj => ({ Key: obj.Key }))
              }
            };
            await s3v2.deleteObjects(deleteParams).promise();
          }
          ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : null;
        } while (ContinuationToken);
      } catch (e) {
        console.error('Error borrando prefijo completo en Spaces:', prefix, e);
      }
    }

    // 3) Eliminar fila de la base de datos
    await pool.query(
      `DELETE FROM propiedades
        WHERE id = $1`,
      [id]
    );

    // 4) Crear notificación interna
    await pool.query(
      `INSERT INTO notifications (user_id, message, link)
       VALUES ($1, $2, $3)`,
      [
        prop.user_id,
        `Tu propiedad “${prop.titulo}” ha sido rechazada por: ${motivo}. Vuelve a llenar el formulario.`,
        '/properties/new'
      ]
    );

    // 5) Enviar correo de notificación
    const userEmailRes = await pool.query(
      `SELECT email
         FROM users
        WHERE id = $1`,
      [prop.user_id]
    );
    const userEmail = userEmailRes.rows[0]?.email;
    if (userEmail) {
      await transporter.sendMail({
        from: `"Inmo360" <no-reply@tu-dominio.com>`,
        to: userEmail,
        subject: 'Tu propiedad ha sido rechazada',
        text: `Lo sentimos, tu propiedad “${prop.titulo}” fue rechazada por el siguiente motivo:\n\n${motivo}\n\nIntenta publicar la propiedad otra vez y evita cometer el mismo error.\n\nSaludos cordiales,\nEquipo Inmo360.`
      });
    }

    res.redirect('/admin/properties');
  } catch (err) {
    console.error('Error al rechazar y eliminar propiedad:', err);
    res.status(500).send('Error interno');
  }
});





















// En tu archivo de rutas o app.js
// server.js (o donde tengas tus rutas)
app.get('/admin/stats/users', requireAdmin, async (req, res) => {
  try {
    // 1. Total de usuarios
    const { rows: [{ count: totalUsersCount }] } =
      await pool.query(`SELECT COUNT(*) AS count FROM users`);
    const totalUsers = parseInt(totalUsersCount, 10);

    // 2. Usuarios por rol
    const rolesRes = await pool.query(`
      SELECT rol, COUNT(*) AS cnt
      FROM users
      GROUP BY rol
    `);

    // 3. Usuarios con foto de perfil
    const { rows: [{ withPicCount }] } =
      await pool.query(`
        SELECT COUNT(*) FILTER (WHERE profile_pic IS NOT NULL) AS "withPicCount"
        FROM users
      `);
    const withPic = parseInt(withPicCount, 10);

    // 4. Usuarios con al menos una propiedad creada
    const { rows: [{ withPropCount }] } =
      await pool.query(`
        SELECT COUNT(DISTINCT u.id) AS "withPropCount"
        FROM users u
        JOIN propiedades p ON p.user_id = u.id
      `);
    const withProp = parseInt(withPropCount, 10);

    // Porcentajes
    const pctWithPic  = totalUsers ? Math.round(withPic  / totalUsers * 100) : 0;
    const pctWithProp = totalUsers ? Math.round(withProp / totalUsers * 100) : 0;

    // 5. Nuevos registros en los últimos 30 días (rellenando días sin registro)
    const signupsRes = await pool.query(`
      SELECT to_char(d::date,'YYYY-MM-DD') AS day,
             COUNT(u.id) AS cnt
      FROM generate_series(now() - interval '29 days', now(), '1 day') AS d
      LEFT JOIN users u
        ON u.created_at::date = d::date
      GROUP BY day
      ORDER BY day
    `);
    const signups = signupsRes.rows.map(r => ({
      day: r.day,
      cnt: parseInt(r.cnt, 10)
    }));
    const signupsTotal = signups.reduce((sum, r) => sum + r.cnt, 0);

    // 6. Usuarios activos diarios (últimos 30 días, rellenando ceros)
    const activeRes = await pool.query(`
      SELECT to_char(d::date,'YYYY-MM-DD') AS day,
             COUNT(u.id) AS cnt
      FROM generate_series(now() - interval '29 days', now(), '1 day') AS d
      LEFT JOIN users u
        ON u.last_login::date = d::date
      GROUP BY day
      ORDER BY day
    `);
    const active = activeRes.rows.map(r => ({
      day: r.day,
      cnt: parseInt(r.cnt, 10)
    }));
    const activeTotal = active.reduce((sum, r) => sum + r.cnt, 0);

    // 7. Top 10 departamentos
    const geoRes = await pool.query(`
      SELECT dept AS departamento, COUNT(*) AS cnt
      FROM users
      WHERE dept IS NOT NULL
      GROUP BY dept
      ORDER BY cnt DESC
      LIMIT 10
    `);

    res.render('statsUsers', {
      totalUsers,
      roles: rolesRes.rows,
      pctWithPic,
      pctWithProp,
      signups,
      signupsTotal,
      active,
      activeTotal,
      geo: geoRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar estadísticas de usuarios');
  }
});


// …
// justo debajo de donde haces: const app = express(), const pool = require('./db'), const requireAdmin = require('./middlewares/requireAdmin'), etc.
// …

// …
// (Asegúrate de que ya has definido: const app = express(); const pool = require('./db'); const requireAdmin = require('./middlewares/requireAdmin'); etc.)
// …

// ------------------------------
// GET /admin/stats/properties — Estadísticas de Propiedades
// ------------------------------
app.get('/admin/stats/properties', requireAdmin, async (req, res) => {
  try {
    // 1. Total de propiedades
    const { rows: [{ count: totalProps }] } = await pool.query(
      `SELECT COUNT(*) AS count FROM propiedades`
    );

    // 2. Propiedades por estado
    const statesRes = await pool.query(`
      SELECT estado, COUNT(*) AS cnt
      FROM propiedades
      GROUP BY estado
    `);

    // 3. Propiedades por tipo
    const typesRes = await pool.query(`
      SELECT tipo_propiedad, COUNT(*) AS cnt
      FROM propiedades
      GROUP BY tipo_propiedad
    `);

    // 4. Propiedades por operación
    const opsRes = await pool.query(`
      SELECT operacion, COUNT(*) AS cnt
      FROM propiedades
      GROUP BY operacion
    `);

    // 5. Precio promedio y mediana por tipo de propiedad
    const priceStatsRes = await pool.query(`
      SELECT
        tipo_propiedad,
        ROUND(AVG(precio)::numeric, 2)                                          AS avg_price,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY precio)::numeric(12,2)     AS med_price
      FROM propiedades
      GROUP BY tipo_propiedad
    `);

    // 6. Nuevas propiedades por día (últimos 30 días)
    const newPerDayRes = await pool.query(`
      SELECT 
        d::date AS day,
        COALESCE(COUNT(p.*), 0) AS cnt
      FROM generate_series((current_date - interval '29 days')::date, current_date::date, '1 day') AS d
      LEFT JOIN propiedades p
        ON p.created_at::date = d::date
      GROUP BY d
      ORDER BY d
    `);

    // 7. Visitas totales, clicks_whatsapp, clicks_telefono, clicks_email por día (últimos 30 días)
    const engagementRes = await pool.query(`
      SELECT
        d::date AS day,
        COALESCE(SUM(p.visitas),0)         AS visitas,
        COALESCE(SUM(p.clicks_whatsapp),0) AS wa_clicks,
        COALESCE(SUM(p.clicks_telefono),0) AS tel_clicks,
        COALESCE(SUM(p.clicks_email),0)    AS email_clicks
      FROM generate_series((current_date - interval '29 days')::date, current_date::date, '1 day') AS d
      LEFT JOIN propiedades p
        ON p.created_at::date = d::date
      GROUP BY d
      ORDER BY d
    `);

    // 8. Top 10 departamentos con más propiedades aprobadas
    const topGeoRes = await pool.query(`
      SELECT departamento, COUNT(*) AS cnt
      FROM propiedades
      WHERE estado = 'aprobada'
      GROUP BY departamento
      ORDER BY cnt DESC
      LIMIT 10
    `);

    // 9. Proporción de lujo vs no lujo
    const { rows: [{ cnt_luxury, cnt_nonlux }] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE luxo = true)  AS cnt_luxury,
        COUNT(*) FILTER (WHERE luxo = false) AS cnt_nonlux
      FROM propiedades
    `);

    // 10. Promedio de imágenes por propiedad, porcentaje con video y porcentaje con plano
    const mediaRes = await pool.query(`
      SELECT
        ROUND(AVG(jsonb_array_length(imagenes_urls))::numeric, 2)    AS avg_images,
        COUNT(*) FILTER (WHERE video_url IS NOT NULL)   AS with_video,
        COUNT(*) FILTER (WHERE plano_url IS NOT NULL)   AS with_plano,
        COUNT(*) AS total_count
      FROM propiedades
    `);
    const {
      avg_images,
      with_video,
      with_plano,
      total_count
    } = mediaRes.rows[0];

    // 11. Top 5 Agencias con más Propiedades publicadas (solo aprobadas)
    const topAgenciesRes = await pool.query(`
      SELECT ag.name AS agency_name, COUNT(*) AS cnt
      FROM propiedades p
      JOIN users u ON p.user_id = u.id
      JOIN inmobiliarias ag ON u.agency_id = ag.id
      WHERE p.estado = 'aprobada'
      GROUP BY ag.name
      ORDER BY cnt DESC
      LIMIT 5
    `);

    // 12. Top 5 Anunciantes con más visitas en los últimos 30 días
    const topAdvertisersRes = await pool.query(`
      SELECT u.username AS advertiser, SUM(p.visitas) AS total_visits
      FROM propiedades p
      JOIN users u ON p.user_id = u.id
      WHERE p.created_at > now() - interval '30 days'
      GROUP BY u.username
      ORDER BY total_visits DESC
      LIMIT 5
    `);

    // 13. Top 5 Propiedades con más visitas en los últimos 30 días
    const topPropsRes = await pool.query(`
      SELECT p.titulo, p.visitas
      FROM propiedades p
      WHERE p.created_at > now() - interval '30 days'
      ORDER BY p.visitas DESC
      LIMIT 5
    `);

    // Renderizamos la vista y le pasamos TODOS los datos:
    res.render('statsProperties', {
      totalProps:       parseInt(totalProps, 10),
      byState:          statesRes.rows,
      byType:           typesRes.rows,
      byOperation:      opsRes.rows,
      priceStats:       priceStatsRes.rows,
      newPerDay:        newPerDayRes.rows,
      engagement:       engagementRes.rows,
      topGeo:           topGeoRes.rows,
      cntLuxury:        parseInt(cnt_luxury, 10),
      cntNonlux:        parseInt(cnt_nonlux, 10),
      avgImages:        parseFloat(avg_images),
      withVideo:        parseInt(with_video, 10),
      withPlano:        parseInt(with_plano, 10),
      totalCount:       parseInt(total_count, 10),
      topAgencies:      topAgenciesRes.rows,
      topAdvertisers:   topAdvertisersRes.rows,
      topProps:         topPropsRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar estadísticas de propiedades');
  }
});


// GET /admin/stats/agencies — Estadísticas de Inmobiliarias
// ... otras configuraciones de express, middleware, etc.

app.get('/admin/stats/agencies', requireAdmin, async (req, res) => {
  try {
    // 1. Total de agencias
    const { rows: [{ count: totalAgencies }] } =
      await pool.query(`SELECT COUNT(*) AS count FROM inmobiliarias`);

    // 2. Agencias por estado
    const statesRes = await pool.query(`
      SELECT estado, COUNT(*) AS cnt
      FROM inmobiliarias
      GROUP BY estado
    `);

    // 3. Nuevas agencias en los últimos 30 días
    const newRes = await pool.query(`
      SELECT to_char(created_at::date,'YYYY-MM-DD') AS day,
             COUNT(*) AS cnt
      FROM inmobiliarias
      WHERE created_at > now() - interval '30 days'
      GROUP BY day
      ORDER BY day
    `);

    // 4. Distribución por departamento (TOP 10)
    const geoRes = await pool.query(`
      SELECT departamento, COUNT(*) AS cnt
      FROM inmobiliarias
      WHERE departamento IS NOT NULL
      GROUP BY departamento
      ORDER BY cnt DESC
      LIMIT 10
    `);

    // 5. Top 5 Agencias con más propiedades publicadas
    const topPropsRes = await pool.query(`
      SELECT i.name            AS agencia,
             COUNT(p.id)       AS cnt_props
      FROM inmobiliarias i
      JOIN users u       ON u.agency_id = i.id
      JOIN propiedades p ON p.user_id = u.id
      WHERE p.estado = 'aprobada'
      GROUP BY i.name
      ORDER BY cnt_props DESC
      LIMIT 5
    `);

    // 6. Top 5 Agencias con más visitas en los últimos 30 días
    const topVisitsRes = await pool.query(`
      SELECT i.name                      AS agencia,
             COALESCE(SUM(p.visitas),0)  AS total_visits
      FROM inmobiliarias i
      JOIN users u       ON u.agency_id = i.id
      JOIN propiedades p ON p.user_id = u.id
      WHERE p.created_at > now() - interval '30 days'
      GROUP BY i.name
      ORDER BY total_visits DESC
      LIMIT 5
    `);

    // 7. Promedio de propiedades por agencia
    //    Si no hay agencias o no tienen propiedades, devolvemos 0
    const { rows: [{ avgprops }] } = await pool.query(`
      SELECT COALESCE(ROUND(AVG(cnt),2), 0)::float AS avgprops
      FROM (
        SELECT i.id, COUNT(p.id) AS cnt
        FROM inmobiliarias i
        JOIN users u       ON u.agency_id = i.id
        JOIN propiedades p ON p.user_id = u.id
        GROUP BY i.id
      ) sub
    `);

    // 8. Porcentaje de agencias que tienen ≥ 5 propiedades
    const { rows: [{ pctfive }] } = await pool.query(`
      SELECT COALESCE(
        ROUND(
          100.0 * SUM(CASE WHEN cnt >= 5 THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*),0)
        , 2)
      , 0)::float AS pctfive
      FROM (
        SELECT i.id, COUNT(p.id) AS cnt
        FROM inmobiliarias i
        JOIN users u       ON u.agency_id = i.id
        JOIN propiedades p ON p.user_id = u.id
        GROUP BY i.id
      ) sub
    `);

    // 9. Top 5 Agencias por ratio de aprobación (aprobadas / totales)
    const topRatioRes = await pool.query(`
      SELECT i.name AS agencia,
             ROUND(
               100.0 * SUM(CASE WHEN p.estado = 'aprobada' THEN 1 ELSE 0 END)
               / NULLIF(COUNT(p.id),0)
             , 2)::float AS approval_ratio
      FROM inmobiliarias i
      JOIN users u       ON u.agency_id = i.id
      JOIN propiedades p ON p.user_id = u.id
      GROUP BY i.name
      HAVING COUNT(p.id) > 0
      ORDER BY approval_ratio DESC
      LIMIT 5
    `);

    // 10. Evolución mensual de nuevas agencias en los últimos 6 meses
    const evoRes = await pool.query(`
      SELECT to_char(created_at, 'YYYY-MM') AS month,
             COUNT(*)                  AS cnt
      FROM inmobiliarias
      WHERE created_at > date_trunc('month', now()) - INTERVAL '5 months'
      GROUP BY month
      ORDER BY month
    `);

    // Renderizar la vista con todos los datos
    res.render('statsAgencies', {
      totalAgencies: parseInt(totalAgencies, 10),
      states:        statesRes.rows,       // [{ estado, cnt }, …]
      newAgencies:   newRes.rows,          // [{ day, cnt }, …]
      geo:           geoRes.rows,          // [{ departamento, cnt }, …]
      topProps:      topPropsRes.rows,     // [{ agencia, cnt_props }, …]
      topVisits:     topVisitsRes.rows,    // [{ agencia, total_visits }, …]
      avgProps:      parseFloat(avgprops), // número
      pctFive:       parseFloat(pctfive),  // número
      topRatio:      topRatioRes.rows,     // [{ agencia, approval_ratio }, …]
      evo:           evoRes.rows           // [{ month, cnt }, …]
    });
  } catch (err) {
    console.error('>>> ERROR en /admin/stats/agencies:', err.stack || err);
    res.status(500).send('Error al cargar estadísticas de inmobiliarias');
  }
});



















// Listar todas las notificaciones del usuario
app.get('/notifications', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const result = await pool.query(
    `SELECT id, message, link, is_read
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  res.json(result.rows);
});

// Marcar una notificación como leída
app.post('/notifications/:id/read', isAuthenticated, async (req, res) => {
  await pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1',
    [req.params.id]
  );
  res.sendStatus(200);
});











// GET: Mostrar formulario de registro de inmobiliaria
// GET: Mostrar formulario de registro de inmobiliaria
app.get('/agencias/registro', (req, res) => {
  // Solo usuarios autenticados
  if (!req.session.user) {
    return res.redirect('/login');
  }
  // Renderiza la vista pasando los departamentos
  res.render('agenciaRegistro', { departamentos });
});


// GET /check-agency?name=...
app.get('/check-agency', async (req, res) => {
  const { name } = req.query;
  try {
    const result = await pool.query(
      'SELECT 1 FROM inmobiliarias WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [name]
    );
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    console.error('Error verificando nombre de agencia:', err);
    res.json({ available: false });
  }
});


// POST: Procesar registro de inmobiliaria
// POST: Procesar registro de inmobiliaria
const agencyUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'uploads', 'agencies');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  }
});

// Asegúrate de tener definido antes:
// const uploadMemory = multer({ storage: multer.memoryStorage(), fileFilter: imageFileFilter, limits });
// const s3v2 = new AWS.S3({ endpoint: new AWS.Endpoint(process.env.SPACES_ENDPOINT), accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET });
// async function processAndUploadToSpacesBuffer(buffer, originalName, userUuid, fieldName) { ... } // con s3v2

// Reemplaza o ajusta esta ruta en tu server.js / app.js

app.post('/agencias/registro', uploadMemory.single('logo'), async (req, res) => {
  const {
    name, email, phone, address,
    departamento, municipio,
    solicitante_nombre,
    solicitante_puesto,
    solicitante_email,
    solicitante_telefono
  } = req.body;

  const userId = req.session.user.id;

  // Para almacenar el logo temporalmente; luego lo subiremos y actualizaremos el registro
  let logoPath = null;

  try {
    // 1) Insertar la nueva agencia sin logo_url (logo_url NULL)
    const insertRes = await pool.query(
      `INSERT INTO inmobiliarias
        (name,
         email,
         phone,
         address,
         departamento,
         municipio,
         logo_url,
         solicitante_nombre,
         solicitante_puesto,
         solicitante_email,
         solicitante_telefono,
         created_by,
         estado)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente')
      RETURNING id`,
      [
        name,
        email,
        phone,
        address,
        departamento || null,
        municipio || null,
        null,  // logo_url inicialmente null
        solicitante_nombre,
        solicitante_puesto,
        solicitante_email,
        solicitante_telefono,
        userId
      ]
    );
    const agencyId = insertRes.rows[0].id;

    // 2) Si vino archivo de logo, subirlo a Spaces bajo agencies/<agencyId>/
    if (req.file) {
      const file = req.file;
      try {
        // Leer buffer y nombre original
        let buffer = file.buffer;
        let originalName = file.originalname;
        let ext = path.extname(originalName).toLowerCase();
        // Si HEIC/HEIF: convertir a JPEG
        if (ext === '.heic' || ext === '.heif') {
          try {
            const outputBuffer = await heicConvert({
              buffer,
              format: 'JPEG',
              quality: 1
            });
            buffer = outputBuffer;
            ext = '.jpg';
            // ajustar nombre
            originalName = path.basename(originalName, path.extname(originalName)) + ext;
          } catch (convErr) {
            console.error('Error conversión HEIC de logo:', convErr);
            // seguir con buffer/originalName original
          }
        }
        // Generar key en Spaces: agencies/<agencyId>/logo-<timestamp><ext>
        const timestamp = Date.now();
        const safeBase = path.basename(originalName).replace(/\s+/g, '_');
        const key = `agencies/${agencyId}/logo-${timestamp}-${safeBase}`;

        // Subir a Spaces usando s3v2
        await s3v2.putObject({
          Bucket: process.env.SPACES_BUCKET,
          Key: key,
          Body: buffer,
          ACL: 'public-read',
          ContentType: file.mimetype || `image/${ext.replace(/^\./, '')}`
        }).promise();

        // Construir URL pública
        logoPath = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${key}`;
        // 3) Actualizar el registro de la agencia con el logo_url
        await pool.query(
          `UPDATE inmobiliarias SET logo_url = $1 WHERE id = $2`,
          [logoPath, agencyId]
        );
      } catch (uploadErr) {
        console.error('Error subiendo logo de agencia a Spaces:', uploadErr);
        // No abortamos; la agencia ya se creó con logo null. Puedes decidir alertar al usuario:
        // Por ahora solo se registra el error en consola.
      }
    }

    // 4) Obtener todos los administradores y notificarles
    const adminsRes = await pool.query(
      `SELECT email FROM users WHERE rol = 'admin' AND email IS NOT NULL`
    );
    const adminEmails = adminsRes.rows.map(r => r.email);
    if (adminEmails.length > 0) {
      try {
        await transporter.sendMail({
          from: "Inmo360 <no-reply@inmo360.com>",
          to: adminEmails, // array de correos
          subject: 'Nueva inmobiliaria pendiente de revisión',
          text: `Se ha registrado una nueva agencia: "${name}".\n\n` +
                `Solicitante: ${solicitante_nombre} (${solicitante_puesto}).\n` +
                `Revisa la solicitud en el panel de administración: https://tu-dominio.com/admin/agencies`
        });
      } catch (mailErr) {
        console.error('Error enviando email a admins sobre nueva agencia:', mailErr);
      }
    }

    // 5) Redirigir al dashboard con éxito
    res.redirect('/dashboard?success=solicitud_enviada');
  } catch (err) {
    console.error('Error registrando inmobiliaria:', err);
    // Si se creó el registro pero falló antes de subir logo, la agencia ya existe con logo_url NULL.
    res.status(500).send('Error al registrar inmobiliaria');
  }
});








// Página principal (home) con panel de búsqueda y propiedades recomendadas
app.get('/', async (req, res) => {
        // DEBUG: listamos la carpeta de vistas
  const viewsPath = path.join(__dirname, 'views');
  console.log('VIEWS DIR:', viewsPath);
  console.log('ARCHIVOS EN VIEWS:', fs.existsSync(viewsPath)
    ? fs.readdirSync(viewsPath)
    : '¡no existe!');
  try {
    // Obtener todas las propiedades desde la base de datos
    const result = await pool.query('SELECT * FROM propiedades');
    const allProperties = result.rows;
    let recommendedProperties = [];
    let hasRecommended = false;

    if (allProperties.length < 6) {
      // Si hay menos de 6 propiedades en total, se oculta la sección recomendada.
      hasRecommended = false;
    } else {
      hasRecommended = true;
      let candidates = [];
      if (req.session.user && req.session.user.city && req.session.user.dept) {
        // Usar "city" y "dept" de la sesión para filtrar.
        const userMunicipio = req.session.user.city.trim().toLowerCase();
        const userDepartamento = req.session.user.dept.trim().toLowerCase();

        // Filtrar propiedades que estén en el mismo municipio (usando comparaciones en minúsculas)
        const recsMunicipio = allProperties.filter(prop => 
          prop.municipio && prop.municipio.trim().toLowerCase() === userMunicipio
        );

        if (recsMunicipio.length >= 6) {
          // Si existen 6 o más propiedades en el mismo municipio, usarlas exclusivamente.
          recommendedProperties = shuffle(recsMunicipio).slice(0, 6);
        } else {
          // Propiedades en el mismo departamento que no estén en el municipio
          const recsDepartamento = allProperties.filter(prop =>
            prop.departamento &&
            prop.departamento.trim().toLowerCase() === userDepartamento &&
            (!prop.municipio || prop.municipio.trim().toLowerCase() !== userMunicipio)
          );
          // Combinar las propiedades del municipio y del departamento
          candidates = recsMunicipio.concat(recsDepartamento);
          // Si la cantidad combinada es menor a 6, agregar el resto de propiedades que no estén en candidates
          if (candidates.length < 6) {
            const candidateIds = new Set(candidates.map(p => p.id));
            const additional = allProperties.filter(prop => !candidateIds.has(prop.id));
            candidates = candidates.concat(additional);
          }
          // Eliminar duplicados (por precaución)
          const uniqueCandidates = candidates.filter((prop, index, self) =>
            index === self.findIndex(p => p.id === prop.id)
          );
          recommendedProperties = shuffle(uniqueCandidates).slice(0, 6);
        }
      } else {
        // Usuario no logueado: usar 6 propiedades aleatorias sin duplicados
        const uniqueAll = allProperties.filter((prop, index, self) =>
          index === self.findIndex(p => p.id === prop.id)
        );
        recommendedProperties = shuffle(uniqueAll).slice(0, 6);
      }
    }
    
    const { departamentos } = locationsData;
    console.log('Departamentos:', departamentos);
    console.log('User session info:', req.session.user);
    
    res.render('index', {
      departamentos,
      hasRecommended,
      recommendedProperties
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      departamentos: [],
      hasRecommended: false,
      recommendedProperties: []
    });
  }
});



// Rutas AJAX para municipios y zonas
app.get('/municipios', (req, res) => {
  const departamento = req.query.departamento;
  const dep = locationsData.departamentos.find(d => d.nombre === departamento);
  if (dep) {
    res.json(dep.municipios);
  } else {
    res.json([]);
  }
});
app.get('/zonas', (req, res) => {
  const departamento = req.query.departamento;
  const municipio = req.query.municipio;
  const dep = locationsData.departamentos.find(d => d.nombre === departamento);
  if (!dep) return res.json([]);
  const mun = dep.municipios.find(m => m.nombre === municipio);
  if (!mun) return res.json([]);
  res.json(mun.zonas);
});

// Autenticación



// GET /register — mostrar departamentos y las inmobiliarias aprobadas
app.get('/register', async (req, res) => {
  try {
    const departamentos    = locationsData.departamentos;
    // Traer las inmobiliarias ya aprobadas
    const agenciesRes      = await pool.query(
      `SELECT id, name AS nombre 
         FROM inmobiliarias 
        WHERE estado = 'aprobada' 
        ORDER BY name`
    );
    const inmobiliarias    = agenciesRes.rows;
    res.render('register', { departamentos, inmobiliarias });
  } catch (err) {
    console.error('Error al cargar registro:', err);
    res.status(500).send('Error al cargar formulario de registro.');
  }
});

// POST /register — crear usuario y login automático, con primer usuario como admin y conversión HEIC
app.post(
  '/register',
  uploadMemory.fields([
    { name: 'profilePic', maxCount: 1 },
    { name: 'idFront',    maxCount: 1 },
    { name: 'idBack',     maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const userUuid = uuidv4();
      const {
        username, email, password,
        dept, city, address, phone,
        belongsToAgency, agency,
        redirectToAgency
      } = req.body;

      // 1) Validar campos obligatorios
      if (!username || !email || !password || !dept || !city || !address || !phone) {
        return res.status(400).send("Todos los campos obligatorios deben estar llenos.");
      }

      // 2) Verificar duplicados
      const dup = await pool.query(
        "SELECT 1 FROM users WHERE username=$1 OR email=$2",
        [username, email]
      );
      if (dup.rows.length) {
        return res.status(400).send("El nombre de usuario o correo ya están registrados.");
      }

      // 3) Determinar rol (primer usuario → admin)
      const countRes = await pool.query("SELECT COUNT(*) AS cnt FROM users");
      const totalUsers = parseInt(countRes.rows[0].cnt, 10);
      const role = totalUsers === 0 ? 'admin' : 'user';

      // 4) Procesar archivos subidos en memoria y subir a Spaces
      let profilePicUrl = null, idFrontUrl = null, idBackUrl = null;
      if (req.files.profilePic && req.files.profilePic.length > 0) {
        const file = req.files.profilePic[0];
        profilePicUrl = await processAndUploadToSpacesBuffer(
          file.buffer, file.originalname, userUuid, 'profilePic'
        );
      }
      if (req.files.idFront && req.files.idFront.length > 0) {
        const file = req.files.idFront[0];
        idFrontUrl = await processAndUploadToSpacesBuffer(
          file.buffer, file.originalname, userUuid, 'idFront'
        );
      }
      if (req.files.idBack && req.files.idBack.length > 0) {
        const file = req.files.idBack[0];
        idBackUrl = await processAndUploadToSpacesBuffer(
          file.buffer, file.originalname, userUuid, 'idBack'
        );
      }

      // 5) Encriptar contraseña
      const hashed = await bcrypt.hash(password, saltRounds);

      // 6) Insertar usuario en BD
      const insertRes = await pool.query(
        `INSERT INTO users
          (username, email, password,
           profile_pic, dept, city, address, phone,
           id_front, id_back,
           belongs_to_agency, agency_id,
           uuid, rol)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          username, email, hashed,
          profilePicUrl, dept, city, address, phone,
          idFrontUrl, idBackUrl,
          (belongsToAgency === 'si'),
          (belongsToAgency === 'si' ? agency : null),
          userUuid,
          role
        ]
      );

      // 7) Enviar email de bienvenida (no detiene el flujo si falla)
      try {
        await transporter.sendMail({
          from: `"Inmo360" <no-reply@inmo360.com>`,
          to: email,
          subject: 'Bienvenido a Inmo360!',
          text: `Hola ${username},\n\n¡Bienvenido a Inmo360! Nos alegra que te hayas registrado. Comienza a explorar y publicar propiedades.\n\nSaludos,\nEl equipo de Inmo360`
        });
      } catch (mailErr) {
        console.error('Error enviando email de bienvenida:', mailErr);
      }

      // 8) Login automático
      const newUser = insertRes.rows[0];
      delete newUser.password;
      req.session.user = newUser;

      // 9) Redirigir según flag
      if (redirectToAgency === 'true') {
        return res.redirect('/agencias/registro');
      }
      res.redirect('/dashboard');

    } catch (err) {
      console.error('Error en POST /register:', err);
      res.status(500).send('Error al crear la cuenta.');
    }
  }
);


// POST /register — crear usuario y, si viene el flag, redirigir a registrar agencia
// Registro de usuarios — login automático tras crear cuenta



app.get('/check-username', async (req, res) => {
  const { username } = req.query;
  // Realiza la consulta a la base de datos
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if(result.rows.length > 0) {
      return res.json({ available: false });
    }
    return res.json({ available: true });
  } catch (error) {
    console.error(error);
    res.json({ available: false });
  }
});

app.get('/check-email', async (req, res) => {
  const { email } = req.query;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if(result.rows.length > 0) {
      return res.json({ available: false });
    }
    return res.json({ available: true });
  } catch (error) {
    console.error(error);
    res.json({ available: false });
  }
});

// Inicio de sesión
app.get('/login', (req, res) => {
  res.render('login');
});


app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // 1) Buscar al usuario por su username, incluyendo profile_pic
    const result = await pool.query(
      `SELECT 
         id,
         username,
         password,
         rol,
         dept,
         city,
         email,
         phone,
         profile_pic
       FROM users 
       WHERE username = $1`,
      [username]
    );
    if (result.rows.length === 0) {
      return res.render('login', { error: "Credenciales incorrectas" });
    }
    
    const user = result.rows[0];
    // 2) Comparar la contraseña en texto plano con la almacenada
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.render('login', { error: "Credenciales incorrectas" });
    }
    
    // 3) Autenticación exitosa: guardar sólo lo necesario (y la foto) en la sesión
    req.session.user = {
      id:          user.id,
      username:    user.username,
      rol:         user.rol,
      dept:        user.dept,
      city:        user.city,
      email:       user.email,
      phone:       user.phone,
      profile_pic: user.profile_pic  // <— aquí
    };

    // 4) Actualizar last_login
    await pool.query(
      'UPDATE users SET last_login = now() WHERE id = $1',
      [user.id]
    );

    // 5) Redirigir según rol
    if (user.rol === 'admin') {
      return res.redirect('/admin');
    }
    res.redirect('/');
    
  } catch (err) {
    console.error(err);
    res.render('login', { error: "Ocurrió un error" });
  }
});


// DASHBOARD
// Ruta principal del dashboard
// Ruta principal del dashboard
app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const { success } = req.query;

    // 1) ¿Pertenece el usuario a una agencia?
    let agency = null;
    if (user.agency_id) {
      const agRes = await pool.query(
        'SELECT id, name FROM inmobiliarias WHERE id = $1',
        [user.agency_id]
      );
      agency = agRes.rows[0] || null;
    }
    // 2) Si no pertenece, ¿la creó?
    if (!agency) {
      const agRes = await pool.query(
        'SELECT id, name FROM inmobiliarias WHERE created_by = $1 LIMIT 1',
        [user.id]
      );
      agency = agRes.rows[0] || null;
    }

    res.render('dashboard', { user, success, agency });
  } catch (err) {
    console.error('Error al cargar el dashboard:', err);
    res.status(500).send('Error al cargar el dashboard.');
  }
});

// Ruta para editar información del perfil
app.get('/dashboard/profile', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1) Cargar usuario
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];

    // 2) Cargar lista de departamentos
    const departamentos = locationsData.departamentos;

    // 3) Cargar inmobiliarias aprobadas para el dropdown
    const agenciesRes = await pool.query(
      `SELECT id, name
         FROM inmobiliarias
        WHERE estado = 'aprobada'
        ORDER BY name`
    );
    const approvedAgencies = agenciesRes.rows;

    // 4) Renderizar la vista con todos los datos
    res.render('profile', {
      user,
      departamentos,
      approvedAgencies
    });
  } catch (err) {
    console.error('Error al cargar el perfil:', err);
    res.status(500).send('Error al cargar el perfil.');
  }
});


app.post(
  '/dashboard/profile',
  isAuthenticated,
  uploadMemory.fields([
    { name: 'profilePic', maxCount: 1 },
    { name: 'idFront',    maxCount: 1 },
    { name: 'idBack',     maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      console.log('🔥 PETICIÓN /dashboard/profile recibida');
      console.log('FILES:', req.files);
      console.log('BODY:',  req.body);

      const userId = req.session.user.id;
      const {
        username,
        email,
        phone,
        address,
        city,
        dept,
        belongsToAgency,
        agency
      } = req.body;

      // Asociación a inmobiliaria
      const belongs = belongsToAgency === 'true';
      const agencyId = belongs ? agency : null;

      // Obtener datos actuales del usuario
      const userResult = await pool.query(
        'SELECT uuid, profile_pic, id_front, id_back FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).send('Usuario no encontrado.');
      }
      const {
        uuid: userUuid,
        profile_pic: currentPicUrl,
        id_front: currentFrontUrl,
        id_back: currentBackUrl
      } = userResult.rows[0];

      // Preparamos objeto para nuevos URLs
      const updateData = { profile_pic: null, id_front: null, id_back: null };

      // Procesar profilePic si viene
      if (req.files.profilePic && req.files.profilePic.length > 0) {
        // Eliminar anterior en Spaces si existía
        if (currentPicUrl) {
          try {
            await deleteFromSpacesByUrl(currentPicUrl);
          } catch (e) {
            console.error('Error borrando anterior profilePic en Spaces:', e);
          }
        }
        const file = req.files.profilePic[0];
        // Subir buffer a Spaces
        const newUrl = await processAndUploadToSpacesBuffer(
          file.buffer,
          file.originalname,
          userUuid,
          'profilePic'
        );
        updateData.profile_pic = newUrl;
      }

      // Procesar idFront si viene
      if (req.files.idFront && req.files.idFront.length > 0) {
        if (currentFrontUrl) {
          try {
            await deleteFromSpacesByUrl(currentFrontUrl);
          } catch (e) {
            console.error('Error borrando anterior idFront en Spaces:', e);
          }
        }
        const file = req.files.idFront[0];
        const newUrl = await processAndUploadToSpacesBuffer(
          file.buffer,
          file.originalname,
          userUuid,
          'idFront'
        );
        updateData.id_front = newUrl;
      }

      // Procesar idBack si viene
      if (req.files.idBack && req.files.idBack.length > 0) {
        if (currentBackUrl) {
          try {
            await deleteFromSpacesByUrl(currentBackUrl);
          } catch (e) {
            console.error('Error borrando anterior idBack en Spaces:', e);
          }
        }
        const file = req.files.idBack[0];
        const newUrl = await processAndUploadToSpacesBuffer(
          file.buffer,
          file.originalname,
          userUuid,
          'idBack'
        );
        updateData.id_back = newUrl;
      }

      // Construir actualización SQL dinámicamente
      const fields = [username, email, phone, address, city, dept];
      const queryParts = [
        'username = $1',
        'email = $2',
        'phone = $3',
        'address = $4',
        'city = $5',
        'dept = $6'
      ];
      let idx = 7;

      if (updateData.profile_pic) {
        fields.push(updateData.profile_pic);
        queryParts.push(`profile_pic = $${idx++}`);
      }
      if (updateData.id_front) {
        fields.push(updateData.id_front);
        queryParts.push(`id_front = $${idx++}`);
      }
      if (updateData.id_back) {
        fields.push(updateData.id_back);
        queryParts.push(`id_back = $${idx++}`);
      }

      // Asociación a agencia
      fields.push(belongs, agencyId);
      queryParts.push(`belongs_to_agency = $${idx++}`, `agency_id = $${idx++}`);

      // WHERE id
      fields.push(userId);
      const sql = `UPDATE users SET ${queryParts.join(', ')} WHERE id = $${idx}`;

      await pool.query(sql, fields);

      // Refrescar sesión con los nuevos datos
      const updated = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      req.session.user = updated.rows[0];

      res.redirect('/dashboard');
    } catch (err) {
      console.error('Error al actualizar perfil:', err);
      res.status(500).send('Error al actualizar el perfil.');
    }
  }
);




// GET /inmobiliaria/:id — Detalle de la agencia y sus propiedades
// Sólo accesible a usuarios autenticados
app.get('/inmobiliaria/:id', isAuthenticated, async (req, res) => {
  try {
    const agencyId = req.params.id;

    // 1) Datos de la inmobiliaria
    const agencyRes = await pool.query(
      `SELECT id, name, logo_url, estado
       FROM inmobiliarias
       WHERE id = $1`,
      [agencyId]
    );
    const agency = agencyRes.rows[0];
    if (!agency) return res.status(404).send('Inmobiliaria no encontrada');

    // 2) Lista de agentes completos
    const agentsListRes = await pool.query(
      `SELECT id, username AS name, profile_pic
       FROM users
       WHERE agency_id = $1`,
      [agencyId]
    );
    const agents = agentsListRes.rows;
    const agentsCount = agents.length;

    // 3) Paginación de propiedades
    const page   = parseInt(req.query.page) || 1;
    const limit  = 6;
    const offset = (page - 1) * limit;

    // 3a) Total de propiedades
    const countPropsRes = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM propiedades p
       JOIN users u ON p.user_id = u.id
       WHERE u.agency_id = $1`,
      [agencyId]
    );
    const totalProps = parseInt(countPropsRes.rows[0].cnt, 10);

    // 3b) Propiedades con nombre de agente
    const propsRes = await pool.query(
      `SELECT
         p.*,
         u.username AS user_name
       FROM propiedades p
       JOIN users u ON p.user_id = u.id
       WHERE u.agency_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agencyId, limit, offset]
    );
    const properties = propsRes.rows;

    // 4) Renderizar vista
    res.render('agencyDetail', {
      agency,
      agentsCount,
      agents,
      properties,
      totalProps,
      page,
      limit
    });
  } catch (err) {
    console.error('Error cargando detalle de inmobiliaria:', err);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta para editar contraseña
app.get('/dashboard/security', isAuthenticated, (req, res) => {
  res.render('edit-password', { error: null, success: null });
});

app.post('/dashboard/security', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      return res.render('edit-password', { error: 'La contraseña actual es incorrecta.', success: null });
    }

    if (newPassword !== confirmPassword) {
      return res.render('edit-password', { error: 'Las nuevas contraseñas no coinciden.', success: null });
    }

    const hashed = await bcrypt.hash(newPassword, saltRounds);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);

    // Redirigir al dashboard tras éxito
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error al cambiar contraseña:', err);
    res.status(500).render('edit-password', { error: 'Ocurrió un error al cambiar la contraseña.', success: null });
  }
});

// Cierre de sesión
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/');
  });
});

// CRUD de Propiedades

// Listado de propiedades con paginación y ordenamiento
const format = require('pg-format'); // Asegúrate de instalar esto con: npm install pg-format

// GET /properties — Mostrar listado de propiedades del usuario con slug en las URLs y pop-up “En revisión”
app.get('/properties', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 9;
  const offset = (page - 1) * limit;

  // Validar campos de orden
  const allowedFields = ['id', 'titulo', 'precio', 'created_at'];
  const allowedOrders = ['ASC', 'DESC'];
  const sortField = allowedFields.includes(req.query.sortField)
    ? req.query.sortField
    : 'id';
  const sortOrder = allowedOrders.includes(req.query.sortOrder?.toUpperCase())
    ? req.query.sortOrder.toUpperCase()
    : 'ASC';

  try {
    // 1) Contar total de propiedades
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM propiedades WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // 2) Traer propiedades con slug
    const sql = format(
      'SELECT id, titulo, slug, imagenes_urls, operacion, precio, visitas, clicks_telefono, clicks_email, clicks_whatsapp, estado '
      + 'FROM propiedades '
      + 'WHERE user_id = %L '
      + 'ORDER BY %I %s '
      + 'LIMIT %L OFFSET %L',
      userId, sortField, sortOrder, limit, offset
    );
    const result = await pool.query(sql);
    const propiedades = result.rows;

    // 3) Mostrar modal de “en revisión” si corresponde
    const submitted = req.query.submitted === 'true';

    // 4) Renderizar EJS
    res.render('properties', {
      propiedades,
      page,
      total,
      limit,
      sortField,
      sortOrder,
      submitted
    });
  } catch (err) {
    console.error('Error al cargar propiedades:', err);
    res.render('properties', {
      propiedades: [],
      page: 1,
      total: 0,
      limit,
      sortField,
      sortOrder,
      submitted: false
    });
  }
});

// Formulario para crear una nueva propiedad (solo usuarios autenticados)
app.get('/properties/new', isAuthenticated, (req, res) => {
  const { departamentos } = locationsData;
  res.render('propertyForm', { property: null, departamentos, action: '/properties/new' });
});

// En server.js, justo después de tu app.get('/properties/new', …) coloca este POST:
const { v4: uuidv4 } = require('uuid');

// --- 1) Configuración de storage SOLO para propiedades ---

const propertyStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // asegúrate de que req.uploadFolderUuid ya esté seteado
    const uploadPath = path.join(__dirname, 'public', 'uploads', 'propiedades', req.uploadFolderUuid);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // aquí generamos un nombre único por archivo
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const propertyUpload = multer({ storage: propertyStorage });


// --- 2) Antes de la ruta, inyectamos el UUID en la request ---
// Antes de la ruta, inyectamos un folder UUID para esta petición:
app.use('/properties/new', (req, _res, next) => {
  req.uploadFolderUuid = uuidv4();
  next();
});

// Helper para generar la key en Spaces:
function makeS3Key(prefixFolder, filename) {
  const timestamp = Date.now();
  const baseName = path.basename(filename).replace(/\s+/g, '_');
  return `${prefixFolder}/${timestamp}-${baseName}`;
}

// Helper que toma un buffer y lo sube a Spaces, devolviendo la URL pública:
async function uploadBufferToSpaces(buffer, originalName, prefixFolder) {
  // Detectar extensión original:
  const ext = path.extname(originalName).toLowerCase();
  let finalBuffer = buffer;
  let finalExt = ext;

  // Si es HEIC/HEIF, convertir en memoria a JPEG
  if (ext === '.heic' || ext === '.heif') {
    try {
      const outputBuffer = await heicConvert({
        buffer: buffer,
        format: 'JPEG',
        quality: 1
      });
      finalBuffer = outputBuffer;
      finalExt = '.jpg';
    } catch (convErr) {
      console.error('Error convirtiendo HEIC a JPEG:', convErr);
      // en caso de fallo, seguimos con el buffer original y ext original
    }
  }

  // Definir nombre base para key. Puedes mejorar si quieres:
  const key = makeS3Key(prefixFolder, path.basename(originalName, ext) + finalExt);

  // Subir a Spaces
  try {
    await s3v2.putObject({
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: finalBuffer,
      ACL: 'public-read',
      ContentType: finalExt === '.jpg' || finalExt === '.jpeg' 
        ? 'image/jpeg' 
        : (finalExt === '.png' ? 'image/png' : 'application/octet-stream')
    }).promise();
  } catch (s3Err) {
    console.error('Error subiendo a Spaces:', s3Err);
    throw new Error('Error al subir imagen a Spaces');
  }

  // Construir URL pública (formato típico de DigitalOcean Spaces)
  const url = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${key}`;
  return url;
}

// Ruta POST /properties/new
app.post(
  '/properties/new',
  isAuthenticated,
  uploadMemory.fields([
    { name: 'imagenes', maxCount: 10 },
    { name: 'video',    maxCount: 1 },
    { name: 'plano',    maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const folderUuid = req.uploadFolderUuid;
      const userId = req.session.user.id;

      // Campos de formulario
      const {
        titulo, tipo_propiedad, departamento, municipio, zona,
        operacion, precio, habitaciones, banos, descripcion,
        m2_construccion, m2_terreno, tamano_terreno, metros_frente
      } = req.body;
      const luxuryFlag = Boolean(req.body.luxo);

      // Normalizar arrays de características
      const caracteristicas = Array.isArray(req.body.caracteristicas)
        ? req.body.caracteristicas
        : req.body.caracteristicas ? [req.body.caracteristicas] : [];
      const luxury_features = Array.isArray(req.body.luxury_features)
        ? req.body.luxury_features
        : req.body.luxury_features ? [req.body.luxury_features] : [];
      const caracteristicas_terreno = Array.isArray(req.body.caracteristicas_terreno)
        ? req.body.caracteristicas_terreno
        : req.body.caracteristicas_terreno ? [req.body.caracteristicas_terreno] : [];
      const caracteristicas_bodega = Array.isArray(req.body.caracteristicas_bodega)
        ? req.body.caracteristicas_bodega
        : req.body.caracteristicas_bodega ? [req.body.caracteristicas_bodega] : [];
      const caracteristicas_local = Array.isArray(req.body.caracteristicas_local)
        ? req.body.caracteristicas_local
        : req.body.caracteristicas_local ? [req.body.caracteristicas_local] : [];

      // Validar precio
      const precioNumeric = parseFloat(
        precio
          .toString()
          .trim()
          .replace(/^Q\s*/i, '')
          .replace(/,/g, '')
      );
      if (isNaN(precioNumeric)) {
        return res.status(400).send('Precio inválido');
      }

      // — Procesar imágenes —
      const imagenFiles = req.files['imagenes'] || [];
      const imagenes_urls = [];
      for (const file of imagenFiles) {
        try {
          // Aquí usamos la función optimizada que sube original + webp
          const url = await processAndUploadToSpacesBuffer(
            file.buffer,
            file.originalname,
            folderUuid,
            'imagen'
          );
          imagenes_urls.push(url);
        } catch (errUpload) {
          console.error('Error subiendo imagen en propiedades:', errUpload);
        }
      }

      // — Procesar video —
      let video_url = null;
      if (req.files['video'] && req.files['video'][0]) {
        const file = req.files['video'][0];
        try {
          const keyVid = makeS3Key(`propiedades/${folderUuid}`, file.originalname);
          await s3v2.putObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: keyVid,
            Body: file.buffer,
            ACL: 'public-read',
            ContentType: file.mimetype || 'application/octet-stream'
          }).promise();
          video_url = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${keyVid}`;
        } catch (errVid) {
          console.error('Error subiendo video:', errVid);
        }
      }

      // — Procesar plano —
      let plano_url = null;
      if (req.files['plano'] && req.files['plano'][0]) {
        const file = req.files['plano'][0];
        try {
          // también optimizado para imagenes (ese HEIC → JPEG + webp)
          plano_url = await processAndUploadToSpacesBuffer(
            file.buffer,
            file.originalname,
            folderUuid,
            'plano'
          );
        } catch (errPlano) {
          console.error('Error subiendo plano:', errPlano);
        }
      }

      // Insertar en BD
      const insertRes = await pool.query(
        `INSERT INTO propiedades (
           titulo, tipo_propiedad, departamento, municipio, zona,
           operacion, precio, habitaciones, banos, descripcion,
           m2_construccion, m2_terreno, tamano_terreno, metros_frente,
           imagenes_urls, video_url, plano_url, user_id,
           caracteristicas, luxury_features, luxo, caracteristicas_terreno,
           bodega_tamano, bodega_altura, cantidad_oficinas, cantidad_banos,
           caracteristicas_bodega, local_tamano, caracteristicas_local,
           folder_uuid, estado
         ) VALUES (
           $1,$2,$3,$4,$5,
           $6,$7,$8,$9,$10,
           $11,$12,$13,$14,
           $15,$16,$17,$18,
           $19,$20,$21,$22,
           $23,$24,$25,$26,
           $27,$28,$29,$30,'pendiente'
         )
         RETURNING id`,
        [
          titulo, tipo_propiedad, departamento, municipio, zona,
          operacion, precioNumeric,
          habitaciones ? parseInt(habitaciones, 10) : null,
          banos ? parseInt(banos, 10) : null,
          descripcion,
          m2_construccion ? parseInt(m2_construccion, 10) : null,
          m2_terreno ? parseInt(m2_terreno, 10) : null,
          tamano_terreno ? parseInt(tamano_terreno, 10) : null,
          metros_frente ? parseInt(metros_frente, 10) : null,
          JSON.stringify(imagenes_urls),
          video_url,
          plano_url,
          userId,
          JSON.stringify(caracteristicas),
          JSON.stringify(luxury_features),
          luxuryFlag,
          JSON.stringify(caracteristicas_terreno),
          req.body.bodega_tamano ? parseFloat(req.body.bodega_tamano) : null,
          req.body.bodega_altura ? parseFloat(req.body.bodega_altura) : null,
          req.body.cantidad_oficinas ? parseInt(req.body.cantidad_oficinas, 10) : null,
          req.body.cantidad_banos     ? parseInt(req.body.cantidad_banos, 10)     : null,
          JSON.stringify(caracteristicas_bodega),
          req.body.local_tamano ? parseFloat(req.body.local_tamano) : null,
          JSON.stringify(caracteristicas_local),
          folderUuid
        ]
      );
      const newId = insertRes.rows[0].id;

      // Generar slug
      const rawSlug = titulo
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const finalSlug = `${rawSlug}-${newId}`;
      await pool.query(
        'UPDATE propiedades SET slug = $1 WHERE id = $2',
        [finalSlug, newId]
      );

      // Notificar admins
      const adminsRes = await pool.query(
        `SELECT email FROM users WHERE rol = 'admin' AND email IS NOT NULL`
      );
      const adminEmails = adminsRes.rows.map(r => r.email);
      if (adminEmails.length) {
        await transporter.sendMail({
          from: "Inmo360 <no-reply@inmo360.com>",
          to: adminEmails,
          subject: 'Nueva propiedad pendiente de revisión',
          text: `El usuario ${req.session.user.username} ha subido "${titulo}".`
        });
      }

      return res.redirect('/properties?submitted=true');
    } catch (err) {
      console.error('Error al crear propiedad:', err);
      return res.status(500).send('Error al crear la propiedad.');
    }
  }
);

// Nota: tus otras rutas siguen usando el `upload` original, por ejemplo:
// upload.single('profilePic'), upload.fields([...]) para usuarios, agencias, etc.


// Eliminar propiedad

// Eliminar propiedad
app.post('/properties/delete/:id', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;

  try {
    // 1) Obtener la propiedad y asegurarnos de que pertenece al usuario
    const result = await pool.query(
      `SELECT folder_uuid, imagenes_urls, video_url, plano_url
         FROM propiedades 
        WHERE id = $1 
          AND user_id = $2`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      // O bien no existe o no es tuya
      return res.status(404).send('Propiedad no encontrada o no tienes permiso para borrarla.');
    }

    const { folder_uuid: folderUuid, imagenes_urls, video_url, plano_url } = result.rows[0];

    // 2) Eliminar archivos en Spaces: imágenes, video y plano
    //    Asumimos que deleteFromSpacesByUrl está definido en tu código y usa s3v2
    let urls = [];
    if (imagenes_urls) {
      if (typeof imagenes_urls === 'string') {
        try {
          const arr = JSON.parse(imagenes_urls);
          if (Array.isArray(arr)) {
            urls = urls.concat(arr);
          }
        } catch (e) {
          console.warn('No se pudo parsear imagenes_urls:', e);
        }
      } else if (Array.isArray(imagenes_urls)) {
        urls = urls.concat(imagenes_urls);
      }
    }
    if (video_url) {
      urls.push(video_url);
    }
    if (plano_url) {
      urls.push(plano_url);
    }

    for (const fileUrl of urls) {
      try {
        await deleteFromSpacesByUrl(fileUrl);
      } catch (err) {
        console.error('Error borrando en Spaces URL:', fileUrl, err);
        // Continuar con los siguientes, no interrumpir toda la operación
      }
    }

    // 3) Eliminar la carpeta local con todos los archivos (si usas copias locales)
    const folderPath = path.join(__dirname, 'public', 'uploads', 'propiedades', folderUuid);
    if (fs.existsSync(folderPath)) {
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`Carpeta local eliminada: ${folderPath}`);
      } catch (e) {
        console.error('Error eliminando carpeta local:', e);
      }
    } else {
      console.log(`Carpeta local no encontrada para borrar: ${folderPath}`);
    }

    // 4) Borrar el registro de la base de datos
    await pool.query(
      `DELETE FROM propiedades WHERE id = $1`,
      [id]
    );

    // 5) Redirigir de vuelta al listado
    res.redirect('/properties');
  } catch (err) {
    console.error('Error al eliminar propiedad:', err);
    res.status(500).send('Error eliminando la propiedad.');
  }
});


// Ruta para mostrar detalle de una propiedad
// Ruta para mostrar detalle de una propiedad por slug
app.get('/properties/:slug', async (req, res) => {
  const { slug } = req.params;    // e.g. "mi-casa-bonita-42"

  try {
    // 1) Buscar la propiedad directamente por slug
    const result = await pool.query(`
      SELECT 
        p.*,
        u.username            AS user_name,
        u.profile_pic         AS user_profile_pic,
        u.email               AS user_email,
        u.phone               AS user_phone,
        u.dept                AS user_dept,
        u.city                AS user_city,
        p.user_id,
        p.slug,
        u.belongs_to_agency,
        u.agency_id,
        ag.name               AS agency_name
      FROM propiedades p
      LEFT JOIN users u 
        ON p.user_id = u.id
      LEFT JOIN inmobiliarias ag
        ON u.agency_id = ag.id
      WHERE p.slug = $1
    `, [slug]);

    // 2) Si no existe, devolvemos 404
    if (result.rowCount === 0) {
      return res.status(404).send('Propiedad no encontrada');
    }
    const property = result.rows[0];

    // 3) Control de visitas en sesión (solo si no es el dueño)
    if (!req.session.viewedProperties) {
      req.session.viewedProperties = [];
    }
    const currentUserId = req.session.user?.id || null;
    const isOwner = currentUserId === property.user_id;
    if (!isOwner && !req.session.viewedProperties.includes(property.id)) {
      await pool.query(
        'UPDATE propiedades SET visitas = visitas + 1 WHERE id = $1',
        [property.id]
      );
      req.session.viewedProperties.push(property.id);
    }

    // 4) Parsear JSON de imágenes y eliminar duplicados
    let images = [];
    if (property.imagenes_urls) {
      if (typeof property.imagenes_urls === 'string') {
        try {
          images = JSON.parse(property.imagenes_urls);
        } catch (err) { /* ignora JSON inválido */ }
      } else if (Array.isArray(property.imagenes_urls)) {
        images = property.imagenes_urls;
      }
    }
    images = images.filter((url, i, a) => a.indexOf(url) === i);

    // 5) Video y plano
    const videoUrl = property.video_url || null;
    const planoUrl = property.plano_url || null;

    // 6) Construir objeto del agente
    const agent = {
      profile_pic:     property.user_profile_pic,
      name:            property.user_name,
      email:           property.user_email,
      phone:           property.user_phone,
      dept:            property.user_dept,
      city:            property.user_city,
      belongsToAgency: property.belongs_to_agency,
      agency:          property.agency_name
    };

    // 7) Renderizar la vista con todos los datos
    res.render('propertydetail', {
      property,
      images,
      agent,
      videoUrl,
      planoUrl
    });

  } catch (err) {
    console.error('Error al cargar detalle de la propiedad:', err);
    res.status(500).send('Error al cargar detalle de la propiedad');
  }
});

app.post('/track/phone/:id', async (req, res) => {
  const userId = req.session?.user?.id;
  const propiedadId = req.params.id;

  const result = await pool.query('SELECT user_id FROM propiedades WHERE id = $1', [propiedadId]);
  const ownerId = result.rows[0]?.user_id;

  if (!userId || userId !== ownerId) {
    await pool.query('UPDATE propiedades SET clicks_telefono = clicks_telefono + 1 WHERE id = $1', [propiedadId]);
  }

  res.sendStatus(200);
});

app.post('/track/email/:id', async (req, res) => {
  const userId = req.session?.user?.id;
  const propiedadId = req.params.id;

  const result = await pool.query('SELECT user_id FROM propiedades WHERE id = $1', [propiedadId]);
  const ownerId = result.rows[0]?.user_id;

  if (!userId || userId !== ownerId) {
    await pool.query('UPDATE propiedades SET clicks_email = clicks_email + 1 WHERE id = $1', [propiedadId]);
  }

  res.sendStatus(200);
});

app.post('/track/whatsapp/:id', async (req, res) => {
  const userId = req.session?.user?.id;
  const propiedadId = req.params.id;

  const result = await pool.query('SELECT user_id FROM propiedades WHERE id = $1', [propiedadId]);
  const ownerId = result.rows[0]?.user_id;

  if (!userId || userId !== ownerId) {
    await pool.query('UPDATE propiedades SET clicks_whatsapp = clicks_whatsapp + 1 WHERE id = $1', [propiedadId]);
  }

  res.sendStatus(200);
});

// server.js
// En tu server.js, agrega este handler después de tus rutas existentes:


// Búsqueda básica (manteniendo el ejemplo anterior)
// Al principio del fichero, si no lo tienes ya:

// GET /search — Búsqueda básica (GET)
// GET /search — Búsqueda básica (GET)
// GET /search — Búsqueda básica (GET)
// GET /search — Búsqueda básica (GET)
// GET /search — Búsqueda básica (GET)
// GET /search — Búsqueda básica (GET)
app.get('/search', async (req, res) => {
  const limit  = 6;
  const page   = parseInt(req.query.page) || 1;
  const offset = (page - 1) * limit;

  const {
    departamento,
    municipio,
    zona,
    tipoPropiedad,
    operacion
  } = req.query;

  const departamentos = locationsData.departamentos;
  const userId        = req.session?.user?.id || null;

  // Base SELECT con info_score + engagement_score (sin factor de lujo)
  let sql = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite,

      LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)   AS image_score,
      CASE WHEN p.video_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS video_score,
      CASE WHEN p.plano_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS plano_score,
      LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1) AS desc_score,

      LEAST(p.visitas::float/100,1)                             AS visits_norm,
      LEAST(p.clicks_telefono::float/10,1)                      AS tel_norm,
      LEAST(p.clicks_email::float/10,1)                         AS email_norm,
      LEAST(p.clicks_whatsapp::float/10,1)                      AS wa_norm,

      (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
      ) / 5.0                                                 AS info_score

    FROM propiedades p
    LEFT JOIN users u
      ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag
      ON u.agency_id = ag.id
    LEFT JOIN favoritos f
      ON p.id = f.propiedad_id
     AND f.user_id = $1

    WHERE p.estado = 'aprobada'
  `;
  const params = [userId];

  // Filtros dinámicos
  if (departamento)  { params.push(departamento);  sql += ` AND p.departamento   = $${params.length}`; }
  if (municipio)     { params.push(municipio);     sql += ` AND p.municipio      = $${params.length}`; }
  if (zona)          { params.push(zona);          sql += ` AND p.zona           = $${params.length}`; }
  if (tipoPropiedad) { params.push(tipoPropiedad); sql += ` AND p.tipo_propiedad = $${params.length}`; }
  if (operacion)     { params.push(operacion);     sql += ` AND p.operacion      = $${params.length}`; }

  // Conteo total
  const countQ  = `SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`;
  const total   = parseInt((await pool.query(countQ, params)).rows[0].cnt, 10);

  // Expresión inline para ordenar por final_score (sin lujo)
  const orderExpr = `
    0.7 * (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
    ) / 5.0
    + 0.3 * (
        0.4 * LEAST(p.visitas::float/100,1)
      + 0.2 * LEAST(p.clicks_telefono::float/10,1)
      + 0.2 * LEAST(p.clicks_email::float/10,1)
      + 0.2 * LEAST(p.clicks_whatsapp::float/10,1)
    )
  `;

  // Paginación + ORDER BY final_score
  sql += ` ORDER BY ${orderExpr} DESC, p.created_at DESC`;
  sql += ` LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(sql, params);
    res.render('results', {
      propiedades:   result.rows,
      query:         req.query,
      departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades:   [],
      query:         req.query,
      departamentos,
      total:         0,
      page:          1,
      limit
    });
  }
});

// POST /search — Búsqueda básica (POST)
app.post('/search', async (req, res) => {
  const {
    departamento,
    municipio,
    zona,
    tipoPropiedad,
    operacion
  } = req.body;

  const userId = req.session?.user?.id || null;
  const page   = parseInt(req.body.page) || 1;
  const limit  = 6;
  const offset = (page - 1) * limit;

  let sql = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite,

      LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)   AS image_score,
      CASE WHEN p.video_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS video_score,
      CASE WHEN p.plano_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS plano_score,
      LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1) AS desc_score,
      CASE WHEN p.luxo THEN 1.0 ELSE 0.0 END                   AS luxury_bonus,

      LEAST(p.visitas::float/100,1)                             AS visits_norm,
      LEAST(p.clicks_telefono::float/10,1)                      AS tel_norm,
      LEAST(p.clicks_email::float/10,1)                         AS email_norm,
      LEAST(p.clicks_whatsapp::float/10,1)                      AS wa_norm,

      (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
      ) / 5.0                                                 AS info_score

    FROM propiedades p
    LEFT JOIN users u
      ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag
      ON u.agency_id = ag.id
    LEFT JOIN favoritos f
      ON p.id = f.propiedad_id
     AND f.user_id = $1

    WHERE p.estado = 'aprobada'
  `;
  const params = [userId];

  // filtros idénticos al GET...
  if (departamento)  { params.push(departamento);  sql += ` AND p.departamento   = $${params.length}`; }
  if (municipio)     { params.push(municipio);     sql += ` AND p.municipio      = $${params.length}`; }
  if (zona)          { params.push(zona);          sql += ` AND p.zona           = $${params.length}`; }
  if (tipoPropiedad) { params.push(tipoPropiedad); sql += ` AND p.tipo_propiedad = $${params.length}`; }
  if (operacion)     { params.push(operacion);     sql += ` AND p.operacion      = $${params.length}`; }

  // conteo total...
  const countQ = `SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`;
  const total  = parseInt((await pool.query(countQ, params)).rows[0].cnt, 10);

  // volvemos a declarar orderExpr aquí también (sin factor de lujo)
  const orderExpr = `
    0.7 * (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
    ) / 5.0
    + 0.3 * (
        0.4 * LEAST(p.visitas::float/100,1)
      + 0.2 * LEAST(p.clicks_telefono::float/10,1)
      + 0.2 * LEAST(p.clicks_email::float/10,1)
      + 0.2 * LEAST(p.clicks_whatsapp::float/10,1)
    )
  `;

  // paginación + ORDER BY
  sql += ` ORDER BY ${orderExpr} DESC, p.created_at DESC`;
  sql += ` LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(sql, params);
    res.render('results', {
      propiedades:   result.rows,
      query:         { ...req.body, page },
      departamentos: locationsData.departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades:   [],
      query:         { ...req.body, page },
      departamentos: locationsData.departamentos,
      total:         0,
      page:          1,
      limit
    });
  }
});


// POST /advanced-filters — Filtros avanzados
app.post('/advanced-filters', async (req, res) => {
  const userId = req.session?.user?.id || null;
  const page   = parseInt(req.body.page) || 1;
  const limit  = 6;
  const offset = (page - 1) * limit;

  let sql = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite,

      LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)   AS image_score,
      CASE WHEN p.video_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS video_score,
      CASE WHEN p.plano_url IS NOT NULL THEN 1.0 ELSE 0.0 END  AS plano_score,
      LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1) AS desc_score,
      CASE WHEN p.luxo THEN 1.0 ELSE 0.0 END                   AS luxury_bonus,

      LEAST(p.visitas::float/100,1)                             AS visits_norm,
      LEAST(p.clicks_telefono::float/10,1)                      AS tel_norm,
      LEAST(p.clicks_email::float/10,1)                         AS email_norm,
      LEAST(p.clicks_whatsapp::float/10,1)                      AS wa_norm,

      (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
      + (CASE WHEN p.luxo THEN 1 ELSE 0 END)
      ) / 6.0                                                 AS info_score

    FROM propiedades p
    LEFT JOIN users u
      ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag
      ON u.agency_id = ag.id
    LEFT JOIN favoritos f
      ON p.id = f.propiedad_id
     AND f.user_id = $1

    WHERE p.estado = 'aprobada'
  `;
  const params = [userId];

  function addFilter(condition, rawValue, sanitizer = v => v) {
    if (rawValue !== undefined && rawValue !== '') {
      const value = sanitizer(rawValue);
      params.push(value);
      sql += ` AND ${condition.replace('?', `$${params.length}`)}`;
    }
  }

  // 1) Ubicación
  addFilter('p.departamento = ?', req.body.departamento);
  addFilter('p.municipio    = ?', req.body.municipio);
  addFilter('p.zona         = ?', req.body.zona);

  // 2) Tipo y operación
  addFilter('p.tipo_propiedad = ?', req.body.tipoPropiedad);
  addFilter('p.operacion      = ?', req.body.operacion);

  // 3) Precio
  const stripMoney = s => (s||'').toString().replace(/^Q\s*/i,'').replace(/,/g,'').trim();
  addFilter('p.precio >= ?', req.body.precioMin, stripMoney);
  addFilter('p.precio <= ?', req.body.precioMax, stripMoney);

  // 4) Casa/Apartamento
  addFilter('p.habitaciones >= ?', req.body.habitacionesMin);
  addFilter('p.habitaciones <= ?', req.body.habitacionesMax);
  addFilter('p.banos        >= ?', req.body.banosMin);
  addFilter('p.banos        <= ?', req.body.banosMax);
  addFilter('p.m2_construccion >= ?', req.body.m2ConstruccionMin);
  addFilter('p.m2_construccion <= ?', req.body.m2ConstruccionMax);
  if (req.body.residencial)   sql += ` AND p.caracteristicas @> '["residencial"]'`;
  if (req.body.seguridad24)   sql += ` AND p.caracteristicas @> '["seguridad24"]'`;
  if (req.body.amueblada)     sql += ` AND p.caracteristicas @> '["amueblada"]'`;
  if (req.body.semiAmueblada) sql += ` AND p.caracteristicas @> '["semi_amueblada"]'`;

  // 5) Lujo — ¡Nombres ajustados para coincidir con tus valores!
  if (req.body.luxo) {
    sql += ` AND p.luxo = true`;
    if (req.body.piscina_privada)    sql += ` AND p.luxury_features @> '["piscina_privada"]'`;
    if (req.body.jacuzzi)            sql += ` AND p.luxury_features @> '["jacuzzis"]'`;
    if (req.body.sauna_seco)         sql += ` AND p.luxury_features @> '["sauna_seco"]'`;
    if (req.body.sauna_vapor)        sql += ` AND p.luxury_features @> '["sauna_vapor"]'`;
    if (req.body.vistas_panoramicas) sql += ` AND p.luxury_features @> '["vistas_panoramicas"]'`;
    if (req.body.cancha_futbol)      sql += ` AND p.luxury_features @> '["cancha_futbol"]'`;
    if (req.body.cancha_basket)      sql += ` AND p.luxury_features @> '["cancha_basket"]'`;
  }

  // 6) Terreno
  addFilter('p.tamano_terreno >= ?', req.body.tamanoTerrenoMin);
  addFilter('p.tamano_terreno <= ?', req.body.tamanoTerrenoMax);
  addFilter('p.metros_frente >= ?',  req.body.metrosFrenteMin);
  addFilter('p.metros_frente <= ?',  req.body.metrosFrenteMax);
  if (req.body.orillaCalle)     sql += ` AND p.caracteristicas_terreno @> '["orilla_calle"]'`;
  if (req.body.orillaCarretera) sql += ` AND p.caracteristicas_terreno @> '["orilla_carretera"]'`;

  // 7) Bodega
  if (req.body.tipoPropiedad === 'bodega') {
    addFilter('p.bodega_tamano >= ?',      req.body.bodegaTamanoMin);
    addFilter('p.bodega_tamano <= ?',      req.body.bodegaTamanoMax);
    addFilter('p.bodega_altura >= ?',      req.body.bodegaAlturaMin);
    addFilter('p.bodega_altura <= ?',      req.body.bodegaAlturaMax);
    addFilter('p.cantidad_oficinas >= ?',  req.body.cantidadOficinasMin);
    addFilter('p.cantidad_oficinas <= ?',  req.body.cantidadOficinasMax);
    addFilter('p.cantidad_banos >= ?',     req.body.cantidadBanosMin);
    addFilter('p.cantidad_banos <= ?',     req.body.cantidadBanosMax);
    if (req.body.complejoBodegas) sql += ` AND p.caracteristicas_bodega @> '["complejo"]'`;
    if (req.body.seguridad24)     sql += ` AND p.caracteristicas_bodega @> '["seguridad24"]'`;
    if (req.body.cuentaOficina)   sql += ` AND p.caracteristicas_bodega @> '["oficina"]'`;
    if (req.body.cuentaBanio)     sql += ` AND p.caracteristicas_bodega @> '["bano"]'`;
    if (req.body.orillaAutopista) sql += ` AND p.caracteristicas_bodega @> '["orillaAutopista"]'`;
  }

  // 8) Local comercial
  if (req.body.tipoPropiedad === 'local comercial') {
    addFilter('p.local_tamano >= ?', req.body.localTamanoMin);
    addFilter('p.local_tamano <= ?', req.body.localTamanoMax);
    if (req.body.plaza)       sql += ` AND p.caracteristicas_local @> '["plaza"]'`;
    if (req.body.bano_propio) sql += ` AND p.caracteristicas_local @> '["bano_propio"]'`;
  }

  // Conteo total
  const countQ = `SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`;
  const total  = parseInt((await pool.query(countQ, params)).rows[0].cnt, 10);

  // Orden por “final_score” = 0.7*info_score + 0.3*engagement_score
  const orderExpr = `
    0.7 * (
        LEAST(jsonb_array_length(p.imagenes_urls)::float/5,1)*2
      + CASE WHEN p.video_url IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.plano_url IS NOT NULL THEN 1 ELSE 0 END
      + LEAST(GREATEST(char_length(p.descripcion)::float/200,0),1)
      + (CASE WHEN p.luxo THEN 1 ELSE 0 END)
    ) / 6.0
    + 0.3 * (
        0.4 * LEAST(p.visitas::float/100,1)
      + 0.2 * LEAST(p.clicks_telefono::float/10,1)
      + 0.2 * LEAST(p.clicks_email::float/10,1)
      + 0.2 * LEAST(p.clicks_whatsapp::float/10,1)
    )
  `;

  sql += ` ORDER BY ${orderExpr} DESC, p.created_at DESC`;
  sql += ` LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(sql, params);
    res.render('results', {
      propiedades:   result.rows,
      query:         req.body,
      departamentos: locationsData.departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades:   [],
      query:         req.body,
      departamentos: locationsData.departamentos,
      total:         0,
      page:          1,
      limit
    });
  }
});


// Favoritos
app.get('/favoritos', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
             u.username AS user_name,
             u.profile_pic AS user_profile_pic
      FROM favoritos f
      JOIN propiedades p ON p.id = f.propiedad_id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE f.user_id = $1
    `, [req.session.user.id]);

    console.log(result.rows.map(p => ({ id: p.id, operacion: p.operacion })));

    res.render('favoritos', { propiedades: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar favoritos');
  }
});
// Marcar favorito
app.post('/favoritos/:id', async (req, res) => {
  const propiedadId = parseInt(req.params.id, 10);
  const userId = req.session.user?.id;

  console.log('propiedadId:', propiedadId);
  console.log('userId:', userId);

  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  if (isNaN(propiedadId)) return res.status(400).json({ error: 'ID inválido' });

  try {
    await pool.query(
      'INSERT INTO favoritos (user_id, propiedad_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, propiedadId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar favorito' });
  }
});

// Desmarcar favorito
app.delete('/favoritos/:id', async (req, res) => {
  const propiedadId = req.params.id;
  const userId = req.session.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, error: 'No autenticado' });
  }

  try {
    await pool.query(
      'DELETE FROM favoritos WHERE user_id = $1 AND propiedad_id = $2',
      [userId, propiedadId]
    );
    // Respondemos con JSON en lugar de hacer un redirect
    res.json({ success: true });
  } catch (err) {
    console.error('Error al eliminar favorito:', err);
    res.status(500).json({ success: false, error: 'Error al eliminar favorito' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
