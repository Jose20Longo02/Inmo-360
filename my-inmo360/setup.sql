-- 0) (Opcional) Conéctate a tu nueva base de datos
-- \c tu_basedatos

-- 1) Soltar tablas (en orden inverso)
DROP TABLE IF EXISTS propiedades    CASCADE;
DROP TABLE IF EXISTS users          CASCADE;
DROP TABLE IF EXISTS inmobiliarias  CASCADE;

-- 2) Crear inmobiliarias
CREATE TABLE inmobiliarias (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  address     TEXT,
  phone       VARCHAR(30),
  email       VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Crear users (necesita inmobiliarias)
CREATE TABLE users (
  id                 SERIAL PRIMARY KEY,
  username           VARCHAR(50)  NOT NULL UNIQUE,
  email              VARCHAR(255) NOT NULL UNIQUE,
  password           VARCHAR(255) NOT NULL,
  profile_pic        TEXT         NOT NULL,
  dept               VARCHAR(100) NOT NULL,
  city               VARCHAR(100) NOT NULL,
  address            TEXT         NOT NULL,
  phone              VARCHAR(30)  NOT NULL,
  id_front           TEXT,
  id_back            TEXT,
  belongs_to_agency  BOOLEAN      NOT NULL DEFAULT FALSE,
  agency_id          INTEGER      REFERENCES inmobiliarias(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 4) Crear propiedades (necesita users)
CREATE TABLE propiedades (
  id                      SERIAL PRIMARY KEY,
  titulo                  VARCHAR(255)  NOT NULL,
  tipo_propiedad          VARCHAR(50)   NOT NULL,
  departamento            VARCHAR(100)  NOT NULL,
  municipio               VARCHAR(100)  NOT NULL,
  zona                    VARCHAR(100)  NOT NULL,
  operacion               VARCHAR(20)   NOT NULL,  -- 'compra' o 'renta'
  precio                  NUMERIC(12,2) NOT NULL,
  habitaciones            INTEGER,
  banos                   INTEGER,
  descripcion             TEXT         NOT NULL,
  m2_construccion         INTEGER,
  m2_terreno              INTEGER,
  tamano_terreno          INTEGER,
  metros_frente           INTEGER,
  imagenes_urls           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  video_url               TEXT,
  plano_url               TEXT,
  user_id                 INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caracteristicas         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  caracteristicas_terreno JSONB        NOT NULL DEFAULT '[]'::jsonb,
  luxo                    BOOLEAN      NOT NULL DEFAULT FALSE,
  luxury_features         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);