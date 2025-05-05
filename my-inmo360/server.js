// server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const multer = require('multer');
const pool = require('./db');
const methodOverride = require('method-override');
const locationsData = require('./locations');
const { departamentos } = locationsData;
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
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, '/tmp'); // Guardado temporal, moveremos después
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});

// Configuración para aceptar imágenes, video y plano
const upload = multer({ storage });


app.get('/owners', (req, res) => {
  res.render('owners');
});

app.get('/agencies', (req, res) => {
  res.render('agencies');
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
  res.render('admin'); // aquí irá el panel
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

// Endpoint para actualizar perfil de usuario
app.post('/dashboard/profile', isAuthenticated, upload.fields([
  { name: 'profilePic', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 }
]), async (req, res) => {
  try {
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

    // Determinar asociación a inmobiliaria
    const belongs = belongsToAgency === 'true';
    const agencyId = belongs ? agency : null;

    // Obtener UUID y fotos actuales
    const userResult = await pool.query(
      'SELECT uuid, profile_pic, id_front, id_back FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).send('Usuario no encontrado.');

    const { uuid: userUuid, profile_pic: currentPic, id_front: currentFront, id_back: currentBack } = userResult.rows[0];
    const userFolder = path.join(__dirname, 'public', 'uploads', 'usuarios', userUuid);
    if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });

    const updateData = { profile_pic: null, id_front: null, id_back: null };

    // Procesar nuevos archivos si existen
    if (req.files['profilePic']) {
      if (currentPic) {
        const oldPath = path.join(__dirname, 'public', currentPic);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      const file = req.files['profilePic'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.profile_pic = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }
    if (req.files['idFront']) {
      if (currentFront) fs.unlinkSync(path.join(__dirname, 'public', currentFront));
      const file = req.files['idFront'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.id_front = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }
    if (req.files['idBack']) {
      if (currentBack) fs.unlinkSync(path.join(__dirname, 'public', currentBack));
      const file = req.files['idBack'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.id_back = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }

    // Construir arrays de campos y parámetros
    const fields = [
      username,
      email,
      phone,
      address,
      city,
      dept
    ];
    const queryParts = [
      'username = $1',
      'email = $2',
      'phone = $3',
      'address = $4',
      'city = $5',
      'dept = $6'
    ];
    let paramIndex = 7;

    // Archivos actualizados
    if (updateData.profile_pic) {
      fields.push(updateData.profile_pic);
      queryParts.push(`profile_pic = $${paramIndex++}`);
    }
    if (updateData.id_front) {
      fields.push(updateData.id_front);
      queryParts.push(`id_front = $${paramIndex++}`);
    }
    if (updateData.id_back) {
      fields.push(updateData.id_back);
      queryParts.push(`id_back = $${paramIndex++}`);
    }

    // Asociación a inmobiliaria
    fields.push(belongs, agencyId);
    queryParts.push(`belongs_to_agency = $${paramIndex++}`, `agency_id = $${paramIndex++}`);

    // WHERE
    fields.push(userId);
    const updateQuery = `UPDATE users SET ${queryParts.join(', ')} WHERE id = $${paramIndex}`;

    // Ejecutar actualización
    await pool.query(updateQuery, fields);

    // Refrescar sesión
    const updatedRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    req.session.user = updatedRes.rows[0];

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error al actualizar perfil:', err);
    res.status(500).send('Error al actualizar el perfil.');
  }
});

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
        text: `¡Felicidades! Tu inmobiliaria “${agency.name}” ya está activa en la plataforma.\n\nVisítala aquí: https://tu-dominio.com/inmobiliaria/${id}`
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

    // 2) Borrar archivo de logo si existe
    if (agency.logo_url) {
      const logoPath = path.join(__dirname, 'public', agency.logo_url);
      if (fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
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
        text: `Lo sentimos, tu inmobiliaria “${agency.name}” fue rechazada por el siguiente motivo:\n\n${motivo}\n\nPor favor, vuelve a completar el formulario aquí: https://tu-dominio.com/agencias/registro`
      });
    }

    res.redirect('/admin/agencies');
  } catch (err) {
    console.error('Error al rechazar inmobiliaria:', err);
    res.status(500).send('Error al rechazar');
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

app.post('/agencias/registro', agencyUpload.single('logo'), async (req, res) => {
  const {
    name, email, phone, address,
    departamento, municipio,
    solicitante_nombre,
    solicitante_puesto,
    solicitante_email,
    solicitante_telefono
  } = req.body;

  const userId = req.session.user.id;
  const logoPath = req.file ? '/uploads/agencies/' + req.file.filename : null;

  try {
    await pool.query(
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
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente')`,
      [
        name,
        email,
        phone,
        address,
        departamento || null,
        municipio      || null,
        logoPath,
        solicitante_nombre,
        solicitante_puesto,
        solicitante_email,
        solicitante_telefono,
        userId
      ]
    );
    res.redirect('/dashboard?success=solicitud_enviada');
  } catch (err) {
    console.error('Error registrando inmobiliaria:', err);
    res.status(500).send('Error al registrar inmobiliaria');
  }
});










// Página principal (home) con panel de búsqueda y propiedades recomendadas
app.get('/', async (req, res) => {
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


// POST /register — crear usuario y, si viene el flag, redirigir a registrar agencia
// Registro de usuarios — login automático tras crear cuenta
app.post('/register',
  upload.fields([
    { name: 'profilePic', maxCount: 1 },
    { name: 'idFront',     maxCount: 1 },
    { name: 'idBack',      maxCount: 1 }
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

      // Validar obligatorios
      if (!username || !email || !password || !dept || !city || !address || !phone) {
        return res.status(400).send("Todos los campos obligatorios deben estar llenos.");
      }

      // Verificar duplicados
      const dup = await pool.query(
        "SELECT 1 FROM users WHERE username=$1 OR email=$2",
        [username, email]
      );
      if (dup.rows.length) {
        return res.status(400).send("El nombre de usuario o correo ya están registrados.");
      }

      // Carpeta de usuario
      const userFolder = path.join(__dirname, 'public', 'uploads', 'usuarios', userUuid);
      if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });

      // Procesar archivos
      let profilePic = null, idFront = null, idBack = null;
      if (req.files.profilePic) {
        const f = req.files.profilePic[0];
        fs.renameSync(f.path, path.join(userFolder, f.originalname));
        profilePic = `/uploads/usuarios/${userUuid}/${f.originalname}`;
      }
      if (req.files.idFront) {
        const f = req.files.idFront[0];
        fs.renameSync(f.path, path.join(userFolder, f.originalname));
        idFront = `/uploads/usuarios/${userUuid}/${f.originalname}`;
      }
      if (req.files.idBack) {
        const f = req.files.idBack[0];
        fs.renameSync(f.path, path.join(userFolder, f.originalname));
        idBack = `/uploads/usuarios/${userUuid}/${f.originalname}`;
      }

      // Encriptar contraseña
      const hashed = await bcrypt.hash(password, saltRounds);

      // Insertar usuario y devolver toda la fila
      const insertRes = await pool.query(
        `INSERT INTO users
          (username, email, password,
           profile_pic, dept, city, address, phone,
           id_front, id_back,
           belongs_to_agency, agency_id,
           uuid)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          username, email, hashed,
          profilePic, dept, city, address, phone,
          idFront, idBack,
          (belongsToAgency === 'si'),
          (belongsToAgency === 'si' ? agency : null),
          userUuid
        ]
      );

      // Guardar en sesión para login automático
      const newUser = insertRes.rows[0];
      delete newUser.password;   // opcional: no almacenar el hash en sesión
      req.session.user = newUser;

      // Si vienen redirectToAgency, lo mandamos a registrar inmobiliaria
      if (redirectToAgency === 'true') {
        return res.redirect('/agencias/registro');
      }

      // En otro caso, al dashboard directamente
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Error en registro:', err);
      res.status(500).send('Error al crear la cuenta.');
    }
  }
);

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
    
    // Buscar al usuario por nombre de usuario
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (result.rows.length === 0) {
      return res.render('login', { error: "Credenciales incorrectas" });
    }
    
    const user = result.rows[0];
    // Comparar la contraseña en texto plano con la contraseña encriptada
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.render('login', { error: "Credenciales incorrectas" });
    }
    
    // Autenticación exitosa: guardar usuario en sesión
    delete user.password;  // opcional: no almacenar hash en la sesión
    req.session.user = user;

    // Redirigir según rol
    if (user.rol === 'admin') {
      return res.redirect('/admin');
    }

    // Usuario normal
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

// Endpoint para actualizar perfil de usuario
app.post('/dashboard/profile', isAuthenticated, upload.fields([
  { name: 'profilePic', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 }
]), async (req, res) => {
  try {
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

    // Determinar asociación a inmobiliaria
    const belongs = belongsToAgency === 'true';
    const agencyId = belongs ? agency : null;

    // Obtener UUID y fotos actuales
    const userResult = await pool.query(
      'SELECT uuid, profile_pic, id_front, id_back FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).send('Usuario no encontrado.');

    const { uuid: userUuid, profile_pic: currentPic, id_front: currentFront, id_back: currentBack } = userResult.rows[0];
    const userFolder = path.join(__dirname, 'public', 'uploads', 'usuarios', userUuid);
    if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });

    const updateData = { profile_pic: null, id_front: null, id_back: null };

    // Procesar nuevos archivos si existen
    if (req.files['profilePic']) {
      if (currentPic) {
        const oldPath = path.join(__dirname, 'public', currentPic);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      const file = req.files['profilePic'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.profile_pic = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }
    if (req.files['idFront']) {
      if (currentFront) fs.unlinkSync(path.join(__dirname, 'public', currentFront));
      const file = req.files['idFront'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.id_front = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }
    if (req.files['idBack']) {
      if (currentBack) fs.unlinkSync(path.join(__dirname, 'public', currentBack));
      const file = req.files['idBack'][0];
      const newPath = path.join(userFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      updateData.id_back = `/uploads/usuarios/${userUuid}/${file.originalname}`;
    }

    // Construir arrays de campos y parámetros
    const fields = [
      username,
      email,
      phone,
      address,
      city,
      dept
    ];
    const queryParts = [
      'username = $1',
      'email = $2',
      'phone = $3',
      'address = $4',
      'city = $5',
      'dept = $6'
    ];
    let paramIndex = 7;

    // Archivos actualizados
    if (updateData.profile_pic) {
      fields.push(updateData.profile_pic);
      queryParts.push(`profile_pic = $${paramIndex++}`);
    }
    if (updateData.id_front) {
      fields.push(updateData.id_front);
      queryParts.push(`id_front = $${paramIndex++}`);
    }
    if (updateData.id_back) {
      fields.push(updateData.id_back);
      queryParts.push(`id_back = $${paramIndex++}`);
    }

    // Asociación a inmobiliaria
    fields.push(belongs, agencyId);
    queryParts.push(`belongs_to_agency = $${paramIndex++}`, `agency_id = $${paramIndex++}`);

    // WHERE
    fields.push(userId);
    const updateQuery = `UPDATE users SET ${queryParts.join(', ')} WHERE id = $${paramIndex}`;

    // Ejecutar actualización
    await pool.query(updateQuery, fields);

    // Refrescar sesión
    const updatedRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    req.session.user = updatedRes.rows[0];

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error al actualizar perfil:', err);
    res.status(500).send('Error al actualizar el perfil.');
  }
});


// GET /inmobiliaria/:id — Detalle de la agencia y sus propiedades
app.get('/inmobiliaria/:id', isAuthenticated, async (req, res) => {
  try {
    const agencyId = req.params.id;
    // Cargar datos de la inmobiliaria
    const agencyRes = await pool.query(
      'SELECT * FROM inmobiliarias WHERE id = $1',
      [agencyId]
    );
    const agency = agencyRes.rows[0];
    if (!agency) {
      return res.status(404).send('Inmobiliaria no encontrada');
    }

    // Contar agentes
    const agentsRes = await pool.query(
      'SELECT COUNT(*) FROM users WHERE agency_id = $1',
      [agencyId]
    );
    const agentsCount = parseInt(agentsRes.rows[0].count, 10);

    // Paginación de propiedades
    const page = parseInt(req.query.page) || 1;
    const limit = 6;
    const offset = (page - 1) * limit;
    const countPropsRes = await pool.query(`
      SELECT COUNT(*) FROM propiedades p
      JOIN users u ON p.user_id = u.id
      WHERE u.agency_id = $1
    `, [agencyId]);
    const totalProps = parseInt(countPropsRes.rows[0].count, 10);

    const propsRes = await pool.query(`
      SELECT p.* FROM propiedades p
      JOIN users u ON p.user_id = u.id
      WHERE u.agency_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [agencyId, limit, offset]);
    const properties = propsRes.rows;

    res.render('agencyDetail', {
      agency,
      agentsCount,
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

app.get('/properties', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = 9;
  const offset = (page - 1) * limit;

  // Solo permitimos campos válidos para ordenamiento
  const allowedFields = ['id', 'titulo', 'precio', 'created_at'];
  const allowedOrders = ['ASC', 'DESC'];

  const sortField = allowedFields.includes(req.query.sortField) ? req.query.sortField : 'id';
  const sortOrder = allowedOrders.includes(req.query.sortOrder?.toUpperCase()) ? req.query.sortOrder.toUpperCase() : 'ASC';

  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM propiedades WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].count);

    const query = format(
      'SELECT * FROM propiedades WHERE user_id = %L ORDER BY %I %s LIMIT %L OFFSET %L',
      userId, sortField, sortOrder, limit, offset
    );

    const result = await pool.query(query);
    const propiedades = result.rows;

    res.render('properties', {
      propiedades,
      page,
      total,
      limit,
      sortField,
      sortOrder
    });
  } catch (err) {
    console.error(err);
    res.render('properties', {
      propiedades: [],
      page: 1,
      total: 0,
      limit,
      sortField,
      sortOrder
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

app.post('/properties/new', isAuthenticated, upload.fields([
  { name: 'imagenes', maxCount: 10 },
  { name: 'video', maxCount: 1 },
  { name: 'plano', maxCount: 1 }
]), async (req, res) => {
  try {
    const uuid = uuidv4();
    const userId = req.session.user.id;
    const baseFolder = path.join(__dirname, 'public', 'uploads', 'propiedades', uuid);
    if (!fs.existsSync(baseFolder)) {
      fs.mkdirSync(baseFolder, { recursive: true });
    }

    let {
      titulo, tipo_propiedad, departamento, municipio, zona, operacion, precio,
      habitaciones, banos, descripcion, m2_construccion, m2_terreno,
      tamano_terreno, metros_frente
    } = req.body;

    let caracteristicas = Array.isArray(req.body.caracteristicas) ? req.body.caracteristicas : req.body.caracteristicas ? [req.body.caracteristicas] : [];
    let luxury_features = Array.isArray(req.body.luxury_features) ? req.body.luxury_features : req.body.luxury_features ? [req.body.luxury_features] : [];
    let caracteristicas_terreno = Array.isArray(req.body.caracteristicas_terreno) ? req.body.caracteristicas_terreno : req.body.caracteristicas_terreno ? [req.body.caracteristicas_terreno] : [];

    const luxo = req.body.luxo === 'on' || req.body.luxo === 'true' || req.body.luxo === 'si';
    const rawPrecio = precio.toString().trim().replace(/^Q\s*/i, '').replace(/,/g, '');
    const precioNumeric = parseFloat(rawPrecio);
    if (isNaN(precioNumeric)) throw new Error('Precio inválido');

    const imagenesFiles = req.files['imagenes'] || [];
    const videoFile = req.files['video'] ? req.files['video'][0] : null;
    const planoFile = req.files['plano'] ? req.files['plano'][0] : null;

    const imagenes_urls = [];
    for (let file of imagenesFiles) {
      const newPath = path.join(baseFolder, file.originalname);
      fs.renameSync(file.path, newPath);
      imagenes_urls.push(`/uploads/propiedades/${uuid}/${file.originalname}`);
    }

    let video_url = null;
    if (videoFile) {
      const newVideoPath = path.join(baseFolder, videoFile.originalname);
      fs.renameSync(videoFile.path, newVideoPath);
      video_url = `/uploads/propiedades/${uuid}/${videoFile.originalname}`;
    }

    let plano_url = null;
    if (planoFile) {
      const newPlanoPath = path.join(baseFolder, planoFile.originalname);
      fs.renameSync(planoFile.path, newPlanoPath);
      plano_url = `/uploads/propiedades/${uuid}/${planoFile.originalname}`;
    }

    let bodega_tamano = req.body.bodega_tamano || null;
    let bodega_altura = req.body.bodega_altura || null;
    let cantidad_oficinas = req.body.cantidad_oficinas || null;
    let cantidad_banos = req.body.cantidad_banos || null;
    let caracteristicas_bodega = Array.isArray(req.body.caracteristicas_bodega) ? req.body.caracteristicas_bodega : req.body.caracteristicas_bodega ? [req.body.caracteristicas_bodega] : [];
    let local_tamano = req.body.local_tamano || null;
    let caracteristicas_local = Array.isArray(req.body.caracteristicas_local) ? req.body.caracteristicas_local : req.body.caracteristicas_local ? [req.body.caracteristicas_local] : [];

    await pool.query(
      `INSERT INTO propiedades
         (titulo, tipo_propiedad, departamento, municipio, zona,
          operacion, precio, habitaciones, banos, descripcion,
          m2_construccion, m2_terreno, tamano_terreno, metros_frente,
          imagenes_urls, video_url, plano_url, user_id,
          caracteristicas, luxo, luxury_features, caracteristicas_terreno,
          bodega_tamano, bodega_altura, cantidad_oficinas, cantidad_banos, caracteristicas_bodega,
          local_tamano, caracteristicas_local, folder_uuid)
       VALUES
         ($1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21, $22,
          $23, $24, $25, $26, $27,
          $28, $29, $30)`,
      [
        titulo, tipo_propiedad, departamento, municipio, zona,
        operacion, precioNumeric,
        habitaciones === '' ? null : parseInt(habitaciones, 10),
        banos === '' ? null : parseInt(banos, 10),
        descripcion,
        m2_construccion === '' ? null : parseInt(m2_construccion, 10),
        m2_terreno === '' ? null : parseInt(m2_terreno, 10),
        tamano_terreno === '' ? null : parseInt(tamano_terreno, 10),
        metros_frente === '' ? null : parseInt(metros_frente, 10),
        JSON.stringify(imagenes_urls),
        video_url,
        plano_url,
        userId,
        JSON.stringify(caracteristicas),
        luxo,
        JSON.stringify(luxury_features),
        JSON.stringify(caracteristicas_terreno),
        bodega_tamano,
        bodega_altura,
        cantidad_oficinas ? parseInt(cantidad_oficinas) : null,
        cantidad_banos ? parseInt(cantidad_banos) : null,
        JSON.stringify(caracteristicas_bodega),
        local_tamano,
        JSON.stringify(caracteristicas_local),
        uuid  // <<< AQUI GUARDAMOS EL UUID
      ]
    );

    res.redirect('/properties');
  } catch (err) {
    console.error('Error al crear propiedad:', err);
    res.status(500).send('Error al crear la propiedad.');
  }
});




// Formulario para editar una propiedad
app.get('/properties/edit/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  try {
    const result = await pool.query('SELECT * FROM propiedades WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.send('Propiedad no encontrada');
    }
    const property = result.rows[0];
    const { departamentos } = locationsData;
    res.render('propertyForm', { property, departamentos, action: `/properties/edit/${id}` });
  } catch (err) {
    console.error(err);
    res.send('Error al cargar la propiedad.');
  }
});

// Manejar la actualización de una propiedad
app.post('/properties/edit/:id', isAuthenticated, upload.single('imagen'), async (req, res) => {
  const id = req.params.id;
  const {
    titulo, departamento, municipio, zona, tipo_propiedad, operacion,
    precio, habitaciones, banos, descripcion,
    bodega_tamano, bodega_altura, cantidad_oficinas, cantidad_banos,
    local_tamano
  } = req.body;

  let imagen_url = null;
  if (req.file) {
    imagen_url = `/uploads/${req.file.filename}`;
  }

  let caracteristicas_bodega = req.body['caracteristicas_bodega[]'] || [];
  let caracteristicas_local = req.body['caracteristicas_local[]'] || [];

  if (!Array.isArray(caracteristicas_bodega)) caracteristicas_bodega = [caracteristicas_bodega];
  if (!Array.isArray(caracteristicas_local)) caracteristicas_local = [caracteristicas_local];

  const rawPrecio = precio.toString().trim().replace(/^Q\s*/i, '').replace(/,/g, '');
  const precioNumeric = parseFloat(rawPrecio);

  try {
    const query = `UPDATE propiedades SET
      titulo=$1, departamento=$2, municipio=$3, zona=$4, tipo_propiedad=$5,
      operacion=$6, precio=$7, habitaciones=$8, banos=$9, descripcion=$10,
      imagen_url=${imagen_url ? '$11,' : ''}
      bodega_tamano=$${imagen_url ? 12 : 11},
      bodega_altura=$${imagen_url ? 13 : 12},
      cantidad_oficinas=$${imagen_url ? 14 : 13},
      cantidad_banos=$${imagen_url ? 15 : 14},
      caracteristicas_bodega=$${imagen_url ? 16 : 15},
      local_tamano=$${imagen_url ? 17 : 16},
      caracteristicas_local=$${imagen_url ? 18 : 17}
      WHERE id=$${imagen_url ? 19 : 18}`;

    const values = [
      titulo, departamento, municipio, zona, tipo_propiedad,
      operacion, precioNumeric, parseInt(habitaciones), parseInt(banos), descripcion
    ];

    if (imagen_url) values.push(imagen_url);
    values.push(
      bodega_tamano || null,
      bodega_altura || null,
      cantidad_oficinas ? parseInt(cantidad_oficinas) : null,
      cantidad_banos ? parseInt(cantidad_banos) : null,
      JSON.stringify(caracteristicas_bodega),
      local_tamano || null,
      JSON.stringify(caracteristicas_local),
      id
    );

    await pool.query(query, values);
    res.redirect('/properties');
  } catch (err) {
    console.error(err);
    res.send('Error al actualizar la propiedad.');
  }
});

// Eliminar propiedad

app.post('/properties/delete/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;

  try {
    // Primero buscamos el folder_uuid asociado a esta propiedad
    const result = await pool.query('SELECT folder_uuid FROM propiedades WHERE id = $1', [id]);
    const propiedad = result.rows[0];

    if (!propiedad) {
      return res.status(404).send('Propiedad no encontrada.');
    }

    const folderUUID = propiedad.folder_uuid;
    const folderPath = path.join(__dirname, 'public', 'uploads', 'propiedades', folderUUID);

    // Luego eliminamos la propiedad de la base de datos
    await pool.query('DELETE FROM propiedades WHERE id = $1', [id]);

    // Y después intentamos eliminar la carpeta si existe
    if (folderUUID && fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log(`Carpeta eliminada: ${folderPath}`);
    }

    res.redirect('/properties');
  } catch (err) {
    console.error('Error al eliminar la propiedad:', err);
    res.status(500).send('Error al eliminar la propiedad.');
  }
});



// Ruta para mostrar detalle de una propiedad
app.get('/properties/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        u.username        AS user_name,
        u.profile_pic     AS user_profile_pic,
        u.email           AS user_email,
        u.phone           AS user_phone,
        u.dept            AS user_dept,
        u.city            AS user_city,
        u.belongs_to_agency,
        u.agency_id
      FROM propiedades p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).send('Propiedad no encontrada');
    }

    const property = result.rows[0];

    // 🔒 Prevenir visitas múltiples de mismo visitante por sesión
    if (!req.session.viewedProperties) {
      req.session.viewedProperties = [];
    }

    const currentUserId = req.session?.user?.id || null;
    const isOwner = currentUserId && currentUserId === property.user_id;
    const alreadyViewed = req.session.viewedProperties.includes(id);

    if (!isOwner && !alreadyViewed) {
      await pool.query('UPDATE propiedades SET visitas = visitas + 1 WHERE id = $1', [id]);
      req.session.viewedProperties.push(id);
    }

    // Parsear JSON de imágenes
    let images = [];
    if (property.imagenes_urls) {
      if (typeof property.imagenes_urls === 'string') {
        try {
          images = JSON.parse(property.imagenes_urls);
        } catch {}
      } else if (Array.isArray(property.imagenes_urls)) {
        images = property.imagenes_urls;
      }
    }

    const videoUrl = property.video_url || null;
    const planoUrl = property.plano_url || null;

    const agent = {
      profile_pic:       property.user_profile_pic,
      name:              property.user_name,
      email:             property.user_email,
      phone:             property.user_phone,
      dept:              property.user_dept,
      city:              property.user_city,
      belongs_to_agency: property.belongs_to_agency,
      agency_id:         property.agency_id
    };

    res.render('propertyDetail', {
      property,
      images,
      agent,
      videoUrl,
      planoUrl
    });
  } catch (err) {
    console.error(err);
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
app.get('/search', async (req, res) => {
  const limit = 6;
  const page = parseInt(req.query.page) || 1;
  const offset = (page - 1) * limit;

  const { departamento, municipio, zona, tipoPropiedad, operacion } = req.query;
  const departamentos = locationsData.departamentos;
  const userId = req.session?.user?.id || null;

  // Construir consulta dinámica con los nuevos campos y JOIN
  let queryStr = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite
    FROM propiedades p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag ON u.agency_id = ag.id
    LEFT JOIN favoritos f ON p.id = f.propiedad_id AND f.user_id = $1
    WHERE 1=1
  `;
  const params = [userId];

  if (departamento) {
    queryStr += ` AND p.departamento = $${params.length + 1}`;
    params.push(departamento);
  }
  if (municipio) {
    queryStr += ` AND p.municipio = $${params.length + 1}`;
    params.push(municipio);
  }
  if (zona) {
    queryStr += ` AND p.zona = $${params.length + 1}`;
    params.push(zona);
  }
  if (tipoPropiedad) {
    queryStr += ` AND p.tipo_propiedad = $${params.length + 1}`;
    params.push(tipoPropiedad);
  }
  if (operacion) {
    queryStr += ` AND p.operacion = $${params.length + 1}`;
    params.push(operacion);
  }

  // Conteo total
  const countQuery = `SELECT COUNT(*) FROM (${queryStr}) AS sub`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].count, 10);

  // Paginación
  queryStr += ` ORDER BY p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(queryStr, params);
    res.render('results', {
      propiedades: result.rows,
      query: req.query,
      departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades: [],
      query: req.query,
      departamentos,
      total: 0,
      page: 1,
      limit
    });
  }
});


// POST /search — Búsqueda básica (POST)
app.post('/search', async (req, res) => {
  const { departamento, municipio, zona, tipoPropiedad, operacion } = req.body;
  const userId = req.session?.user?.id || null;
  const page = parseInt(req.body.page) || 1;
  const limit = 6;
  const offset = (page - 1) * limit;

  // JOIN idéntico al GET
  let baseQuery = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite
    FROM propiedades p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag ON u.agency_id = ag.id
    LEFT JOIN favoritos f ON p.id = f.propiedad_id AND f.user_id = $1
    WHERE 1=1
  `;
  const params = [userId];

  if (departamento) {
    params.push(departamento);
    baseQuery += ` AND p.departamento = $${params.length}`;
  }
  if (municipio) {
    params.push(municipio);
    baseQuery += ` AND p.municipio = $${params.length}`;
  }
  if (zona) {
    params.push(zona);
    baseQuery += ` AND p.zona = $${params.length}`;
  }
  if (tipoPropiedad) {
    params.push(tipoPropiedad);
    baseQuery += ` AND p.tipo_propiedad = $${params.length}`;
  }
  if (operacion) {
    params.push(operacion);
    baseQuery += ` AND p.operacion = $${params.length}`;
  }

  // Conteo total
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM (${baseQuery}) AS sub`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Agregar paginación al query
  baseQuery += ` ORDER BY p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(baseQuery, params);
    res.render('results', {
      propiedades: result.rows,
      query: { ...req.body, page },
      departamentos: locationsData.departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades: [],
      query: { ...req.body, page },
      departamentos: locationsData.departamentos,
      total: 0,
      page: 1,
      limit
    });
  }
});


// POST /advanced-filters — Filtros avanzados
app.post('/advanced-filters', async (req, res) => {
  const userId = req.session?.user?.id || null;
  const page   = parseInt(req.query.page) || 1;
  const limit  = 6;
  const offset = (page - 1) * limit;

  // SELECT con los mismos JOINs
  let query = `
    SELECT
      p.*,
      u.username            AS user_name,
      u.profile_pic         AS user_profile_pic,
      u.belongs_to_agency   AS belongs_to_agency,
      ag.logo_url           AS logo_inmobiliaria,
      CASE WHEN f.user_id IS NOT NULL THEN true ELSE false END AS is_favorite
    FROM propiedades p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN inmobiliarias ag ON u.agency_id = ag.id
    LEFT JOIN favoritos f ON p.id = f.propiedad_id AND f.user_id = $1
    WHERE 1=1
  `;
  const params = [userId];

  // Función para añadir filtros
  function addFilter(condition, value) {
    if (value !== undefined && value !== '') {
      params.push(value);
      query += ` AND ${condition.replace('?', `$${params.length}`)}`;
    }
  }

  // Aplica todos los filtros como ya tenías…
  addFilter('p.departamento = ?',       req.body.departamento);
  addFilter('p.municipio = ?',          req.body.municipio);
  addFilter('p.zona = ?',               req.body.zona);
  addFilter('p.tipo_propiedad = ?',     req.body.tipoPropiedad);
  addFilter('p.operacion = ?',          req.body.operacion);
  addFilter('precio >= ?',              req.body.precioMin);
  addFilter('precio <= ?',              req.body.precioMax);
  // … y el resto de condiciones específicas …

  // Conteo total
  const countRes = await pool.query(
    `SELECT COUNT(*) FROM (${query}) AS subquery`,
    params
  );
  const total = parseInt(countRes.rows[0].count, 10);

  // Paginación
  query += ` ORDER BY p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(query, params);
    res.render('results', {
      propiedades: result.rows,
      query: req.body,
      departamentos: locationsData.departamentos,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.render('results', {
      propiedades: [],
      query: req.body,
      departamentos: locationsData.departamentos,
      total: 0,
      page: 1,
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

  if (!userId) return res.status(401).json({ error: 'No autenticado' });

  try {
    await pool.query(
      'DELETE FROM favoritos WHERE user_id = $1 AND propiedad_id = $2',
      [userId, propiedadId]
    );
    res.redirect('/favoritos');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar favorito' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
