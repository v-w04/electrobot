# ============================================================
#  Revision de credenciales antes de subir
# ============================================================
#  Lo llama _seguro.bat. Sale con codigo 1 si encuentra algo.
#
#  Se hace en PowerShell y no en el .bat porque las expresiones
#  regulares con comillas dentro de un .bat son un campo minado.
#
#  El reto no es encontrar credenciales: es no gritar cuando no
#  las hay. Una alarma que salta seguido y siempre es falsa se
#  acaba ignorando, y ese dia deja de servir justo cuando
#  importaba.
# ============================================================

$archivos = @()
foreach ($p in @('worker\src\*.js', 'worker\*.toml', '*.js', '*.html')) {
    $archivos += Get-ChildItem -Path $p -ErrorAction SilentlyContinue
}
if ($archivos.Count -eq 0) { exit 0 }

# --- Por contexto: el nombre de la variable delata al valor ---
$patrones = @(
    @{ n = 'cookie de sesion';  r = '(PHPSESSID|JSESSIONID|ASP\.NET_SessionId|csrftoken|session_id\s*=\s*\w{8,})' },
    @{ n = 'token Bearer';      r = 'Bearer\s+[A-Za-z0-9\-\._~\+\/]{20,}' },
    @{ n = 'password asignado'; r = '(?i)pass(word|wd)?\s*[:=]\s*["''][^"'']{4,}["'']' },
    @{ n = 'llave de API';      r = '(?i)(api[_-]?key|apikey|secret|client[_-]?secret|token)\s*[:=]\s*["''][^"'']{8,}["'']' },
    @{ n = 'PIN en el codigo';  r = '(?i)\bpin\s*[:=]\s*["'']?\d{6,}' }
)

# --- Por forma: no importa como se llame la variable ---
#
# OJO: se comparan con -cmatch, que SI distingue mayusculas. El -match
# normal las ignora, y con eso cualquier URL con 'YJU' en medio casaba
# contra 'eyJ' y daba alerta falsa en cada commit.
$porForma = @(
    @{ n = 'token de bot de Telegram'; r = '\b\d{8,12}:[A-Za-z0-9_\-]{30,}' },
    @{ n = 'JWT / cookie de sesion';   r = 'eyJ[A-Za-z0-9_\-]{15,}' },
    @{ n = 'llave con prefijo';        r = '(sk|pk|rk|ghp|gho|xox[bap])[_\-](live|test|prod)?[_\-]?[A-Za-z0-9]{12,}' },
    @{ n = 'llave privada (cuenta de servicio)'; r = 'BEGIN (RSA |EC )?PRIVATE KEY|"private_key"\s*:' }
)

# La URL del worker es publica a proposito: la trae el frontend.
$permitidas = @('workers.dev', 'docs.google.com', 'api.telegram.org/bot')

# Un nombre de constante no es un secreto. Pero solo se perdona si ADEMAS
# es corto: las llaves de API tambien son minusculas con guiones, y esas
# son largas. 'ODOO_API_KEY' es un nombre; 'sk-live-9f8a7b6c' es fuga.
function EsNombreNoSecreto([string]$valor) {
    if ($valor -eq '')                                               { return $true }
    if ($valor -match 'PON_|EJEMPLO|CAMBIA|TU_')                     { return $true }
    if ($valor -match '^\{.*\}$')                                   { return $true }
    if ($valor -cmatch '^[A-Z0-9_]+$'   -and $valor.Length -le 32)   { return $true }
    if ($valor -cmatch '^[a-z0-9_\-]+$' -and $valor.Length -le 16)   { return $true }
    return $false
}

$fuga = 0

foreach ($a in $archivos) {
    $lineas = Get-Content -Path $a.FullName -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt $lineas.Count; $i++) {
        $linea = $lineas[$i]

        # Los comentarios hablan DE las credenciales sin contenerlas.
        if ($linea -match '^\s*(\*|//|#|REM |<!--)') { continue }

        $saltar = $false
        foreach ($ok in $permitidas) {
            if ($linea -like ('*' + $ok + '*')) { $saltar = $true }
        }
        if ($saltar) { continue }

        $encontrado = ''

        foreach ($p in $porForma) {
            if ($linea -cmatch $p.r) { $encontrado = $p.n; break }
        }

        if ($encontrado -eq '') {
            foreach ($p in $patrones) {
                if ($linea -match $p.r) {
                    $valor = ''
                    $todas = [regex]::Matches($linea, '["'']([^"'']{4,})["'']')
                    if ($todas.Count -gt 0) { $valor = $todas[$todas.Count - 1].Groups[1].Value }
                    if (EsNombreNoSecreto $valor) { continue }
                    $encontrado = $p.n
                    break
                }
            }
        }

        if ($encontrado -ne '') {
            $recorte = $linea.Trim()
            $corte = [Math]::Min(70, $recorte.Length)
            Write-Host ("        ALERTA: " + $encontrado + " en " + $a.Name + " linea " + ($i + 1))
            Write-Host ("                " + $recorte.Substring(0, $corte))
            $fuga = 1
        }
    }
}

exit $fuga
