# Releases firmadas del agente

Este directorio genera los tres archivos que se adjuntan manualmente a una GitHub Release:

- `GRF.ITAgent-<version>-win-x64.exe.gz`: únicamente el ejecutable del agente comprimido.
- `manifest-<channel>.json`: contrato exacto que consume el actualizador.
- `manifest-<channel>.json.sig`: firma RSA-PSS/SHA-256 detached, codificada en Base64.

Los scripts son compatibles con Windows PowerShell 5.1. La criptografía moderna se ejecuta mediante el pequeño helper .NET 10 incluido, sin paquetes NuGet.

## 1. Crear la clave una sola vez

Abrí Windows PowerShell **como administrador** y ejecutá:

```powershell
Set-Location C:\ruta\sistema-tickets-back\agent\windows\release
.\New-SigningKey.ps1
```

La clave privada se crea por defecto en:

```text
C:\ProgramData\GRF\ITAgent\release-keys\agent-release-private.pem
```

El script impide guardarla dentro del repositorio y reemplaza su ACL para que sólo el grupo local Administradores tenga acceso. Nunca copies ni subas el archivo privado. La clave pública puede distribuirse con el agente y será el ancla de confianza del actualizador.

Guardá una copia offline cifrada de la clave privada. Si se pierde, los agentes instalados no confiarán en releases firmadas con una clave nueva hasta recibir una actualización manual.

## 2. Publicar el agente

Desde `agent\windows`:

```powershell
.\publish.ps1 `
  -UpdateChannel pilot `
  -UpdatePublicKeyPath "C:\ProgramData\GRF\ITAgent\release-keys\agent-release-public.pem"
```

Esos dos parámetros son obligatorios para el primer instalador: copian la clave pública y la URL fija del canal al paquete publicado. Así, cada PC queda con el ancla de confianza necesaria para validar actualizaciones futuras.

## 3. Preparar una release piloto

La URL debe terminar exactamente con el nombre del artefacto que producirá el script:

```powershell
.\release\New-AgentRelease.ps1 `
  -PublishedDirectory .\artifacts\win-x64 `
  -Version 0.2.0 `
  -Channel pilot `
  -DownloadUrl "https://github.com/illeiva2/grf-it-agent-releases/releases/download/pilot/GRF.ITAgent-0.2.0-win-x64.exe.gz" `
  -PrivateKeyPath "C:\ProgramData\GRF\ITAgent\release-keys\agent-release-private.pem" `
  -MinAgentVersion 0.1.0
```

Los canales usan tags móviles fijos: la release/tag `pilot` contiene `manifest-pilot.json`, su firma y el artefacto versionado; `stable` usa los nombres equivalentes. La configuración de cada agente consulta siempre una URL estable:

```text
https://github.com/illeiva2/grf-it-agent-releases/releases/download/pilot/manifest-pilot.json
https://github.com/illeiva2/grf-it-agent-releases/releases/download/stable/manifest-stable.json
```

Este tooling no inicia sesión en GitHub ni publica archivos por sí mismo. La primera vez, creá el repositorio público y la release piloto desde la PC de IT; omití el comando correspondiente si ya existen:

```powershell
gh repo create illeiva2/grf-it-agent-releases `
  --public `
  --add-readme `
  --description "Releases firmadas del agente IT de GRF"

gh release create pilot `
  --repo illeiva2/grf-it-agent-releases `
  --title "Canal piloto del agente GRF" `
  --prerelease `
  --notes "Canal móvil para validar actualizaciones antes de promoverlas a stable."
```

Después adjuntá los tres archivos de `release\out`:

```powershell
gh release upload pilot `
  --repo illeiva2/grf-it-agent-releases `
  .\release\out\GRF.ITAgent-0.2.0-win-x64.exe.gz `
  .\release\out\manifest-pilot.json `
  .\release\out\manifest-pilot.json.sig `
  --clobber
```

Las PCs no instalan `gh`, no usan credenciales y no reciben ningún token de GitHub.

El manifiesto contiene únicamente:

```json
{"version":"0.2.0","channel":"pilot","url":"https://github.com/illeiva2/grf-it-agent-releases/releases/download/pilot/GRF.ITAgent-0.2.0-win-x64.exe.gz","sha256":"...","size":123456,"publishedAt":"2026-07-13T18:00:00.000Z","minAgentVersion":"0.1.0"}
```

`url` debe usar HTTPS y uno de dos hosts exactos: `github.com` u `objects.githubusercontent.com`. No se aceptan subdominios parecidos, credenciales dentro de la URL ni puertos alternativos.

## 4. Promover a estable

Después de verificar la versión en las PCs piloto, volvé a generar los tres archivos con
`-Channel stable`, una URL bajo `/download/stable/` y `-Force` para reemplazar el artefacto
determinístico del directorio `out`. La primera vez creá la release estable y luego subí los
adjuntos indicando siempre el repositorio explícito:

```powershell
.\release\New-AgentRelease.ps1 `
  -PublishedDirectory .\artifacts\win-x64 `
  -Version 0.2.0 `
  -Channel stable `
  -DownloadUrl "https://github.com/illeiva2/grf-it-agent-releases/releases/download/stable/GRF.ITAgent-0.2.0-win-x64.exe.gz" `
  -PrivateKeyPath "C:\ProgramData\GRF\ITAgent\release-keys\agent-release-private.pem" `
  -MinAgentVersion 0.1.0 `
  -Force

gh release create stable `
  --repo illeiva2/grf-it-agent-releases `
  --title "Canal estable del agente GRF" `
  --notes "Canal móvil de producción."

gh release upload stable `
  --repo illeiva2/grf-it-agent-releases `
  .\release\out\GRF.ITAgent-0.2.0-win-x64.exe.gz `
  .\release\out\manifest-stable.json `
  .\release\out\manifest-stable.json.sig `
  --clobber
```

Se debe publicar primero en `pilot` y promover exactamente el mismo ejecutable sólo después
de validarlo.

## Validación local

```powershell
.\Test-ReleaseTooling.ps1
```

Las pruebas verifican reproducibilidad del GZip y del manifiesto, contrato JSON estricto, firma RSA-PSS, detección de manipulación, allowlist de URLs, SemVer y parseo de todos los scripts PowerShell.
