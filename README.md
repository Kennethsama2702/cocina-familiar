# Cocina · Calendario familiar de limpieza

Aplicación web para organizar quién limpia la cocina: rotación Kenneth → Eric → Michael → Marco, excepciones de mamá (que desplazan la rotación), viajes con compensaciones equitativas, historial y estadísticas. La familia lo ve con un enlace, sin cuentas; solo el administrador puede modificar.

## 1. Arquitectura y por qué

| Pieza | Elección | Motivo |
|---|---|---|
| Interfaz | React + TypeScript + Vite | Sin dependencias de UI extra (solo `react` y `@supabase/supabase-js`). Se compila a archivos estáticos: hosting gratis. |
| Base de datos y login | Supabase (PostgreSQL + Auth) | Plan gratuito, datos compartidos entre dispositivos, y **la seguridad se aplica dentro de la base de datos** (RLS y funciones), no en la interfaz. |
| Reglas de negocio | `src/domain` (TypeScript puro) | Rotación, mamá, viajes, compensaciones y estadísticas, sin React ni red. 41 tests. |
| Escritura | Una sola función SQL `apply_change` | Transaccional (todo o nada), exige ser administrador, bloquea días pasados, comprueba invariantes y guarda el historial. |
| Hosting | Netlify (estático) | Gratis, despliegue automático desde GitHub. |

```
src/domain/   reglas de negocio puras (probadas)      src/data/   acceso a Supabase y controlador
src/ui/       pantallas y estilos                     supabase/   migración SQL (esquema + RLS + funciones)
tests/db/     pruebas de seguridad contra PostgreSQL real     tests/e2e/   backend local de prueba
```

### Qué ve quien tiene el enlace
Cualquiera con el enlace **lee** turnos, nombres, excepciones de mamá, ausencias y compensaciones (el historial y los motivos escritos solo si tú lo permites en *Ajustes*). **No** puede escribir nada, no ve tu correo ni contraseña, ni el enlace en sí. El token (256 bits) va en la parte `#` de la URL, que el navegador no envía a ningún servidor. Si se filtra, *Ajustes → Generar enlace nuevo* invalida el anterior al instante.

### Cómo funciona la seguridad
- El rol público (`anon`) **no tiene ningún permiso** sobre las tablas. Los visitantes solo pueden llamar a `get_calendar(token)`, que devuelve datos únicamente si el token es correcto.
- El administrador (un usuario de Supabase Auth listado en `admins`) puede **leer** las tablas por RLS pero **no escribir directamente**: toda modificación pasa por `apply_change`.
- Un disparador (`shifts_lock_past`) impide crear, modificar o borrar días anteriores a hoy **para todos, incluido el administrador y el dueño de la base**. "Hoy" lo calcula el servidor en `America/Guayaquil`, nunca el dispositivo.
- El historial (`change_log`) solo se añade; ausencias y compensaciones se cancelan, no se borran.
- Solo la clave pública `anon` está en el frontend. **Nunca** uses ni pegues la clave `service_role`.

### Reglas clave
- **Mamá hace la cocina (a alguien que no viaja):** inserta su turno ese día y desplaza **un día** toda la rotación posterior. Se acumula si interviene varias veces y persiste entre meses y años (la rotación nunca se recalcula desde cero). Ejemplo: K, E, M, Ma, **Mamá**(en lugar de K), K, E, M…
- **Viajes ("adelantar y recuperar"):** quien viaja sale de la fila durante su ausencia; **los siguientes se adelantan** y, **al volver, esa persona hace su turno de inmediato**. Pasado ese bloque, el patrón vuelve a coincidir con el original.
  - Ejemplo (K viaja vie–sáb): original K, E, M, Ma, K → queda **E, M, K**(al volver), Ma, K…
  - Viaje de un solo día: intercambio simple (E el viernes, K el sábado).
  - Si pierde varios turnos, los recupera **seguidos** al volver.
  - Se indica el **último día fuera**; al día siguiente ya puede cocinar.
- **Mamá y el viaje:** si mamá cubre el turno de quien viaja, es un **reemplazo**: nadie se adelanta y el patrón no se mueve (botón *“Mamá cubre el turno de…”*, o casilla al registrar la ausencia). Si en cambio hace la cocina el día de alguien que no viaja, desplaza todo un día (regla anterior).
- **Equidad sin azar:** cada persona pierde y recupera exactamente los mismos turnos, así que las cuentas se conservan por construcción. Si dos personas viajan a la vez nunca se asigna a un ausente; si no queda nadie, cubre mamá.
- **Compensaciones manuales:** si cedes un turno a otra persona (*Cambiar responsable → generar compensación*), queda una deuda que programas después; el sistema propone fechas del acreedor sin turnos pegados y, si no hay una opción clara, te muestra las alternativas.
- **Cambios y trazabilidad:** cada día conserva su responsable original y quién lo hace ahora; todo cambio queda en el historial con motivo y días afectados. Cancelar una ausencia devuelve los turnos futuros al patrón original (lo ya ocurrido no se toca).
- **Asignado vs. realizado:** se guardan ambos; los días pasados sin registro cuentan como hechos por su responsable; “nadie la hizo” no cuenta. Una tarea reasignada cuenta una sola vez.

---

## 2. Guía paso a paso en Windows

> Cada paso dice **dónde** se ejecuta: *PowerShell*, *panel de Supabase*, *GitHub* o *panel de Netlify*.

### Paso 1 · Programas necesarios
1. **Node.js LTS** (v20 o superior): https://nodejs.org → descargar “LTS” → instalar con todo por defecto.
2. **Git**: https://git-scm.com/download/win → instalar con todo por defecto.
3. Un editor de texto, p. ej. **Visual Studio Code**: https://code.visualstudio.com
4. Cuentas gratuitas en **Supabase** (https://supabase.com), **GitHub** (https://github.com) y **Netlify** (https://netlify.com; entra con tu cuenta de GitHub).

### Paso 2 · Comprobar Node.js y Git
Abre **PowerShell** (tecla Windows → escribe “PowerShell” → Enter) y ejecuta:
```powershell
node -v
npm -v
git --version
```
Deben mostrar versiones (p. ej. `v22.x`, `10.x`, `git version 2.x`). Si dicen “no se reconoce”, cierra y vuelve a abrir PowerShell; si persiste, reinstala.

### Paso 3 · Crear la carpeta del proyecto
Descomprime el ZIP del proyecto (o copia la carpeta `cocina-familiar`) en, por ejemplo, `C:\Proyectos\cocina-familiar`. En **PowerShell**:
```powershell
cd C:\Proyectos\cocina-familiar
dir
```
Debes ver `package.json`, `src`, `supabase`, etc.

### Paso 4 · Instalar dependencias (PowerShell)
```powershell
npm install
```
Si PowerShell bloquea scripts (“la ejecución de scripts está deshabilitada”), ejecuta una vez `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` y confirma con `S`.

Comprueba que las reglas de negocio y la seguridad pasan (no necesita Supabase):
```powershell
npm test
```
Debe terminar con todos los tests en verde (`Tests  59 passed`).

### Paso 5 · Crear el proyecto en Supabase (panel de Supabase)
1. https://supabase.com/dashboard → **New project**. Nombre: `cocina`. Elige una contraseña de base de datos (guárdala) y la región más cercana. Espera ~2 minutos.
2. En el menú **Authentication → Providers → Email**: deja el correo habilitado y **desactiva “Allow new users to sign up”** (en *Authentication → Sign In / Providers* o *Settings*). Así nadie más puede crearse una cuenta.

### Paso 6 · Variables de entorno (PowerShell + archivo)
1. En el panel de Supabase: **Project Settings → API**. Copia **Project URL** y la clave **anon / publishable** (la pública). **No copies `service_role`/`secret`.**
2. En **PowerShell**, dentro de la carpeta del proyecto:
```powershell
Copy-Item .env.example .env.local
notepad .env.local
```
3. Rellena y guarda:
```
VITE_SUPABASE_URL=https://abcdxyz.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

### Paso 7 y 8 · Crear la base de datos, migración y políticas de seguridad (panel de Supabase)
1. **SQL Editor → New query**.
2. Abre `supabase\migrations\0001_init.sql` con el Bloc de notas, copia **todo**, pégalo y pulsa **Run**. Debe decir *Success*. Esto crea las tablas, las políticas RLS, el bloqueo de días pasados y las funciones seguras.
3. Verifica en **Table Editor** que existen `shifts`, `participants`, etc., y que cada tabla muestra **RLS enabled**.

### Paso 9 · Crear tu acceso de administrador
1. Panel de Supabase → **Authentication → Users → Add user → Create new user**: tu correo y una contraseña larga; marca **Auto Confirm User**.
2. **SQL Editor → New query**: abre `supabase\create_admin.sql`, cambia `TU-CORREO@ejemplo.com` por tu correo y pulsa **Run**. Debe mostrar tu correo en el resultado.

### Paso 10 · Probar localmente (PowerShell)
```powershell
npm run dev
```
Abre http://localhost:5173 → entra con tu correo y contraseña → elige quién limpia hoy → **Crear calendario**. En *Ajustes* verás el enlace para la familia; ábrelo en una ventana privada para ver la vista de solo lectura. Para detener el servidor: `Ctrl + C`.

Prueba también el móvil: con el servidor encendido, abre en tu teléfono (mismo Wi‑Fi) `http://IP-de-tu-PC:5173` (ejecuta `npm run dev -- --host`; la IP sale con `ipconfig`).

### Paso 11 · Subir el código a GitHub
1. **GitHub** → **New repository** → nombre `cocina-familiar`, **Private**, sin README → Create.
2. En **PowerShell** (el archivo `.env.local` ya está ignorado por `.gitignore`, no se sube):
```powershell
git init
git add .
git commit -m "Calendario de cocina"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/cocina-familiar.git
git push -u origin main
```
Si Git pide identificarte la primera vez: `git config --global user.name "Tu Nombre"` y `git config --global user.email "tu@correo.com"`.

### Paso 12 · Desplegar en Netlify (panel de Netlify)
1. **Add new site → Import an existing project → GitHub** → elige `cocina-familiar`.
2. Netlify detecta `netlify.toml` (build `npm run build`, carpeta `dist`). Antes de desplegar, abre **Site configuration → Environment variables → Add a variable** y crea:
   - `VITE_SUPABASE_URL` = tu Project URL
   - `VITE_SUPABASE_ANON_KEY` = tu clave anon
3. **Deploy**. Al terminar tendrás una URL tipo `https://tu-sitio.netlify.app`.
4. Entra a esa URL con tu cuenta de administrador → *Ajustes* → copia el enlace de la familia (ahora con la URL pública) y compártelo por WhatsApp.

### Paso 13 · Verificar que los visitantes solo pueden consultar
1. Abre el enlace de la familia en una ventana privada: no hay pestaña “Ajustes” ni botones de edición; al tocar un día solo se ve información.
2. Cambia un carácter del enlace: debe decir *“El enlace no es válido”*.

### Paso 14 · Verificar que un visitante no puede modificar datos manipulando peticiones (PowerShell)
Estos comandos simulan a un atacante que usa solo la clave pública. **Todos deben fallar.** Sustituye los dos valores:
```powershell
$url = "https://TU-PROYECTO.supabase.co"
$key = "TU-CLAVE-ANON"
$h = @{ apikey = $key; Authorization = "Bearer $key"; "Content-Type" = "application/json" }

# 1) Leer las tablas directamente  -> debe dar error 401/403 "permission denied"
Invoke-RestMethod "$url/rest/v1/shifts?select=*" -Headers $h

# 2) Escribir en una tabla  -> debe dar error 401/403
Invoke-RestMethod "$url/rest/v1/shifts" -Method Patch -Headers $h -Body '{"assignee_id":"kenneth"}'

# 3) Llamar a la función de escritura  -> debe dar error 401/403
Invoke-RestMethod "$url/rest/v1/rpc/apply_change" -Method Post -Headers $h -Body '{"p_payload":{}}'

# 4) Pedir el calendario con un token falso  -> debe dar error "INVALID_LINK"
Invoke-RestMethod "$url/rest/v1/rpc/get_calendar" -Method Post -Headers $h -Body '{"p_token":"falso"}'
```
(En PowerShell los errores aparecen en rojo: es lo esperado.) Y este **sí** debe funcionar, con el token real de tu enlace (la parte tras `#/ver/`):
```powershell
Invoke-RestMethod "$url/rest/v1/rpc/get_calendar" -Method Post -Headers $h -Body '{"p_token":"EL-TOKEN-DE-TU-ENLACE"}'
```
Además, el repositorio incluye 18 pruebas automáticas de seguridad contra un PostgreSQL real (`npm run test:db`) que verifican todo esto, el bloqueo de días pasados (incluso para el administrador) y la atomicidad.

### Paso 15 · Actualizar la aplicación
- **Cambios de código:** edita, prueba con `npm test` y `npm run dev`, y luego en **PowerShell**:
```powershell
git add .
git commit -m "Descripción del cambio"
git push
```
Netlify redespliega solo en ~1 minuto.
- **Cambios de base de datos:** crea un archivo nuevo `supabase\migrations\0002_algo.sql` con *solo* el cambio, ejecútalo en el **SQL Editor** de Supabase, y súbelo a GitHub. No edites `0001_init.sql` una vez en producción.
- **Copias de seguridad:** Supabase → *Database → Backups* (el plan gratuito guarda copias recientes; para más seguridad descarga un volcado periódico desde *Database → Backups*).

---

## 3. Uso diario
- **Calendario:** toca un día (desde hoy en adelante) → cambiar responsable (con motivo), *Mamá hace la cocina*, registrar viaje, *Mamá cubre el turno de quien viaja*. Hoy: *Registrar quién la hizo*.
- **Días pasados:** aparecen atenuados y son de solo lectura.
- **Ausencias:** registra la persona, el primer y el último día fuera → revisa cómo queda el calendario (antes/después) y, si quieres, marca los turnos que cubre mamá → guarda.
- **Varios dispositivos:** si dos personas editan a la vez, el segundo guardado avisa (“el calendario cambió”) y recarga, para que nadie pise cambios ajenos.

## 4. Pruebas y desarrollo
```powershell
npm test            # reglas de negocio + seguridad en base de datos real (PGlite)
npm run test:domain # solo reglas
npm run test:db     # solo seguridad SQL
npm run typecheck
npm run build
```
Para probar la interfaz completa sin Supabase: `npx tsx tests/e2e/local-backend.ts` levanta un backend local de prueba (imprime las dos variables y un usuario de prueba) sobre la misma migración SQL.

## 5. Limitaciones conocidas
- Los nombres y colores de los participantes se cambian en la tabla `participants` (Table Editor de Supabase); no hay pantalla para ello.
- La rotación admite exactamente a las personas con `in_rotation = true` ordenadas por `sort_order`; cambiar el orden en producción se hace con *Ajustes → Reiniciar la rotación*.
- No hay notificaciones push ni correo.
