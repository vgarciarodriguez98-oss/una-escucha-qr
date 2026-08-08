# Una escucha QR

Aplicación web para compartir un único QR que apunta siempre a `/escuchar`. Cada navegador recibe una escucha por campaña, sin cuenta ni login. La decisión no reside en el navegador: Cloudflare D1 reserva la escucha de forma atómica antes de permitir servir el audio privado de R2.

## Arquitectura

```text
QR único → /escuchar → Worker → cookie HttpOnly con token aleatorio
                                  ↓
                              D1 (hash del token)
                                  ↓
                 INSERT OR IGNORE + UNIQUE(visitor_id, campaign_id)
                                  ↓
                        cookie de audio temporal HttpOnly
                                  ↓
                       /api/audio → R2 privado (Range)
```

- **Worker TypeScript:** frontend, API, cabeceras y autorización.
- **D1:** canciones, campañas, visitantes con token hasheado, reproducciones, grants y sesiones de admin.
- **R2 privado:** audio y portadas. No se configura dominio público de R2 ni se incluye una clave R2 o URL de archivo en el frontend.
- **Admin:** contraseña solo en secreto de Cloudflare, sesión `HttpOnly`, CSRF double-submit y un límite básico de 8 intentos por 10 minutos usando un hash efímero del origen de la solicitud, nunca la IP en claro.

La reserva se hace mediante `INSERT OR IGNORE ... SELECT ...` y la restricción `UNIQUE(visitor_id, campaign_id)`. Ante dos pestañas o 20 peticiones concurrentes, la base de datos acepta una sola fila; las demás reciben `409`.

## Desarrollo local

Requisitos: Node.js 20+ y npm.

```bash
npm install
Copy-Item .env.example .dev.vars
npm run dev
```

Abre `http://localhost:8787/admin`, inicia sesión con `ADMIN_PASSWORD`, sube una canción y una portada opcional, crea/activa una campaña y prueba `http://localhost:8787/escuchar`.

Wrangler crea D1 y R2 locales simulados al ejecutar `dev`; no necesitas una cuenta ni recursos remotos para esta primera prueba. Para aplicar explícitamente la migración local:

```bash
npx wrangler d1 migrations apply una-escucha-qr --local
```

Prueba la segunda escucha recargando `/escuchar` tras pulsar **Escuchar canción**: D1 devolverá el estado usado. Para ejecutar las comprobaciones:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Despliegue en Cloudflare

1. Crea una cuenta Cloudflare y [autentica Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#login): `npx wrangler login`.
2. Crea la base: `npx wrangler d1 create una-escucha-qr`; copia el `database_id` resultante en `wrangler.toml`.
3. Crea el bucket: `npx wrangler r2 bucket create una-escucha-qr-private`. **No** actives `r2.dev`, dominio público ni una política de acceso público.
4. Aplica esquema remoto: `npx wrangler d1 migrations apply una-escucha-qr --remote`.
5. Crea cuatro secretos, uno por comando: `npx wrangler secret put ADMIN_PASSWORD`, `VISITOR_PEPPER`, `AUTH_SECRET` y `ADMIN_RATE_LIMIT_SECRET`. Usa valores largos y aleatorios (32 bytes o más para los tres últimos).
6. Ejecuta `npm run deploy`. El subdominio `*.workers.dev` permite empezar sin dominio propio. Para despliegue desde GitHub/Workers Builds, configura este mismo comando como **Deploy command**: aplica únicamente migraciones pendientes y luego publica el Worker.
7. Abre `/admin`, sube la canción, crea una campaña activa y descarga el QR. Cambiar la campaña o canción no cambia el QR: sigue siendo `https://tu-dominio/escuchar`.

`COOKIE_SECURE=true` es el valor de producción. Solo usa `false` en `.dev.vars` para `http://localhost`.

## Endpoints importantes

- `GET /api/listening-state`: crea/reconoce visitante y expone solo el estado de la campaña.
- `POST /api/listen`: vuelve a comprobar la campaña y consume atómicamente la escucha. Nunca acepta un `visitor_id` desde JavaScript.
- `GET|HEAD /api/audio`: requiere las dos cookies HttpOnly y una autorización de dos minutos; admite `Range` para Safari/iOS.
- `POST /api/listen/completed`: marca finalización una sola vez, sin registrar progreso por segundo.

El reproductor no muestra descarga, no genera nuevas autorizaciones y bloquea el retroceso en navegadores que lo permiten. Esto no es DRM: una autorización temporal permite al navegador realizar las solicitudes `Range` necesarias y cualquier audio reproducible puede ser grabado/capturado por el usuario.

## Privacidad y limitaciones

Se almacena únicamente:

- hash HMAC de un token aleatorio por navegador, no el token en D1;
- fecha de creación/última visita, campañas y fechas/estado de escucha;
- para defensa de login, hash de corto alcance del origen de la solicitud, no la IP en claro.

No hay fingerprinting, geolocalización, cuentas ni información de dispositivo. Sin login no es posible garantizar una escucha por **persona**: borrar cookies/almacenamiento, usar privado, otro navegador o dispositivo concede una nueva identidad. Es una barrera razonable y respetuosa con privacidad para usuarios normales; D1 gana siempre frente a cualquier estado local del cliente.

## Costes y límites

Verificado el **8 de agosto de 2026** en documentación oficial de Cloudflare:

- [Workers Free](https://developers.cloudflare.com/workers/platform/limits/): 100.000 solicitudes/día, 10 ms de CPU por solicitud y 128 MB de memoria. Al alcanzar el límite diario el Worker deja de atender hasta el reinicio correspondiente.
- [D1 en Workers Free](https://developers.cloudflare.com/d1/platform/pricing/): 5 millones de filas leídas/día, 100.000 escritas/día y 5 GB totales. Al rebasar lectura/escritura D1 devuelve errores hasta 00:00 UTC; si se llena el almacenamiento hay que eliminar datos o pasar a pago.
- [R2](https://developers.cloudflare.com/r2/pricing/): 10 GB-mes de almacenamiento Standard, 1 millón de operaciones Class A y 10 millones Class B al mes; el egress desde R2 (también a través de Worker) no tiene coste. No uses la clase Infrequent Access: no recibe el tier gratuito y tiene recuperación/mínimo de 30 días.

Cloudflare puede actualizar planes o requerir activar la facturación de R2 incluso cuando el consumo quede cubierto por las franquicias; consulta el panel antes de activar el servicio. Esta arquitectura no activa Workers Paid ni otro servicio de pago. Revisa Workers Analytics, D1 > Metrics y R2 > Metrics regularmente. Mantén el audio bajo 10 GB, no hagas polling ni writes de progreso, limita el tamaño de subida y desactiva/elimina campañas y archivos de prueba. Si se espera tráfico alto, configura alertas/presupuestos disponibles en tu cuenta y no habilites productos de pago sin revisar su tarifa: los topes de D1 Free cortan servicio, no convierten por sí solos a pago.

## Seguridad

- R2 es un binding privado; solo el Worker conoce `storage_key`.
- El grant se guarda hasheado en D1, expira y se ata simultáneamente al visitante y a una reproducción.
- `Cache-Control: no-store`, `Content-Disposition: inline` y Range controlado reducen exposición accidental, no prometen impedir copias.
- CSP, HSTS sobre HTTPS, `nosniff`, `Referrer-Policy` y `Permissions-Policy` se aplican a todas las respuestas.
- Subidas: MIME permitido, límites de tamaño y nombres R2 aleatorios generados en servidor. Ajusta los límites en `wrangler.toml` si necesitas menos.

## Troubleshooting

- **“Esta campaña no está disponible”**: crea y activa una campaña desde `/admin`; solo puede haber una activa.
- **Audio 403**: la autorización dura dos minutos y se emite exclusivamente al pulsar escuchar. Recarga no concede otra escucha.
- **Audio 404**: el objeto fue eliminado de R2; sube otra canción/campaña.
- **Cookie no persiste localmente**: confirma `COOKIE_SECURE=false` en `.dev.vars`; en producción debe ser `true` y HTTPS.
- **No se puede eliminar canción**: elimina primero las campañas que la referencian (esto borra su historial de escuchas) o reutilízala en otra campaña.

## Estructura

```text
src/          Worker, autorización, administración y páginas
public/assets/ interfaz responsive sin dependencias de frontend
migrations/    esquema D1 con índices y restricciones
tests/         pruebas de concurrencia, cookies, hashes y Range
wrangler.toml  bindings privados y límites de subida
```
