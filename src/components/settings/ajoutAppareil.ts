// Ajout d'un appareil par copier-coller : la commande à lancer sur la machine à ajouter
// (Linux, macOS ou Windows PowerShell) et la lecture du bloc qu'elle affiche.
// Le bloc ne contient aucun secret : nom, système, compte, adresses, port SSH, empreintes
// de la clé d'hôte, et si la clé publique de ce PC a été ajoutée aux clés autorisées.

export type SystemeAppareil = "linux" | "macos" | "windows";

export const DEBUT = "-----DEBUT APPAREIL SAVIDE-----";
export const FIN = "-----FIN APPAREIL SAVIDE-----";

export type EmpreinteAppareil = { type: string; sha256: string };

export type FicheAppareil = {
  nom: string;
  os: string;
  utilisateur: string;
  ips: string[];
  port: number;
  empreintes: EmpreinteAppareil[];
  /** Le serveur SSH écoute sur le port (null : inconnu). */
  ssh: boolean | null;
  /** Chemin de SavIDE sur la machine, ou null s'il n'y est pas. */
  axecode: string | null;
  /** Clé publique de ce PC ajoutée aux clés autorisées. */
  cle: "oui" | "non" | "echec";
  /** Message de la machine quand l'ajout de la clé a échoué. */
  cleMessage?: string;
};

/** Clé publique OpenSSH sur une ligne, sans caractère qui casserait la commande. */
export function clePublique(texte: string | null | undefined): string | null {
  const m = /^\s*((?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3})(?: ([^\r\n]*))?\s*$/.exec(texte ?? "");
  if (!m) return null;
  const commentaire = (m[2] ?? "").replace(/[^A-Za-z0-9@._-]/g, "").slice(0, 60);
  return commentaire ? `${m[1]} ${commentaire}` : m[1];
}

/** Commande d'une ligne à coller sur la machine à ajouter. `cle` : clé publique de ce PC à autoriser. */
export function commandeAppareil(systeme: SystemeAppareil, cle?: string | null): string {
  const k = clePublique(cle) ?? "";
  if (systeme === "windows") return commandeWindows(k);
  const ips =
    systeme === "macos"
      ? `i=$(ifconfig 2>/dev/null | awk '$1=="inet"&&$2!~/^127\\./{print $2}')`
      : `i=$(ip -o -4 addr show scope global 2>/dev/null | awk '{sub("/.*","",$4);print $4}'); [ -n "$i" ] || i=$(hostname -I 2>/dev/null)`;
  const os =
    systeme === "macos"
      ? `o="macOS $(sw_vers -productVersion 2>/dev/null)"`
      : `o=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); [ -n "$o" ] || o=$(uname -sr)`;
  const clePart = k
    ? `c=non; m=""; b=$(echo "$K" | cut -d" " -f1,2); if mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qF "$b" ~/.ssh/authorized_keys || echo "$K" >> ~/.ssh/authorized_keys; }; then c=oui; echo "Clé de ce PC ajoutée à ~/.ssh/authorized_keys" >&2; else c=echec; m="authorized_keys non modifiable"; fi`
    : `c=non; m=""`;
  return [
    `( K='${k}'`,
    `j(){ printf %s "$1" | tr -d '"\\\\' | tr '\\n\\t' '  '; }`,
    os,
    ips,
    `p=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1)=="port"{print $2;exit}'); [ -n "$p" ] || p=22`,
    `e=$(for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f" 2>/dev/null; done | awk '{t=$NF;gsub(/[()]/,"",t);printf "%s{\\"type\\":\\"%s\\",\\"sha256\\":\\"%s\\"}",s,t,$2;s=","}')`,
    `if (ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -Eq "[:.]$p[[:space:]]"; then l=true; else l=false; fi`,
    `a=$(command -v axecode 2>/dev/null); [ -n "$a" ] && a="\\"$(j "$a")\\"" || a=null`,
    clePart,
    `n=$(echo "$i" | tr " " "\\n" | awk 'NF{printf "%s\\"%s\\"",s,$1;s=","}')`,
    `echo "${DEBUT}"; printf '{"v":1,"nom":"%s","os":"%s","utilisateur":"%s","ips":[%s],"port":%s,"empreintes":[%s],"ssh":%s,"axecode":%s,"cle":"%s","cleMessage":"%s"}' "$(j "$(hostname)")" "$(j "$o")" "$(j "$(id -un)")" "$n" "$p" "$e" "$l" "$a" "$c" "$m" | base64 | tr -d '\\n'; echo; echo "${FIN}" )`,
  ].join("; ");
}

function commandeWindows(k: string): string {
  const clePart = k
    ? `try { if ((whoami /groups) -match 'S-1-5-32-544') { $f="$env:ProgramData\\ssh\\administrators_authorized_keys"; $adm=$true } else { $d="$HOME\\.ssh"; New-Item -ItemType Directory -Force -Path $d | Out-Null; $f="$d\\authorized_keys"; $adm=$false }; $b=($pub -split ' ')[0..1] -join ' '; if (-not ((Test-Path $f) -and (Select-String -Path $f -SimpleMatch $b -Quiet))) { Add-Content -Path $f -Value $pub -Encoding ascii -ErrorAction Stop }; if ($adm) { icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null }; $cle='oui'; Write-Host "Clé de ce PC ajoutée à $f" } catch { $cle='echec'; $msg="$($_.Exception.Message)"; Write-Host "Clé non ajoutée : $msg" }`
    : ``;
  return [
    `& { $pub='${k}'; $cle='non'; $msg=''`,
    `$o=(Get-CimInstance Win32_OperatingSystem).Caption`,
    `$i=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127|169\\.254)\\.' } | ForEach-Object { $_.IPAddress })`,
    `$p=22; $c="$env:ProgramData\\ssh\\sshd_config"; if (Test-Path $c) { $m=Select-String -Path $c -Pattern '^\\s*Port\\s+(\\d+)' | Select-Object -First 1; if ($m) { $p=[int]$m.Matches[0].Groups[1].Value } }`,
    `$e=@(Get-ChildItem "$env:ProgramData\\ssh\\ssh_host_*_key.pub" -ErrorAction SilentlyContinue | ForEach-Object { $l=((ssh-keygen -lf $_.FullName) -split ' '); @{type=$l[-1].Trim('()'); sha256=$l[1]} })`,
    `$s=Get-Service sshd -ErrorAction SilentlyContinue`,
    `$a=(Get-Command axecode -ErrorAction SilentlyContinue).Source`,
    ...(clePart ? [clePart] : []),
    `$j=@{v=1; nom=$env:COMPUTERNAME; os=$o; utilisateur=$env:USERNAME; ips=$i; port=$p; empreintes=$e; ssh=[bool]($s -and $s.Status -eq 'Running'); axecode=$a; cle=$cle; cleMessage=$msg} | ConvertTo-Json -Compress -Depth 4`,
    `'${DEBUT}'; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)); '${FIN}' }`,
  ].join("; ");
}

export type Lecture = { ok: true; fiche: FicheAppareil } | { ok: false; erreur: string };

function base64Texte(b64: string): string | null {
  try {
    const bin = atob(b64);
    const octets = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(octets);
  } catch {
    return null;
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** Lit le bloc collé (avec ses repères, ou le JSON seul). */
export function lireReponse(texte: string): Lecture {
  const brut = (texte ?? "").trim();
  if (!brut) return { ok: false, erreur: "Colle le bloc affiché par la commande." };
  let json: string | null = null;
  const d = brut.indexOf(DEBUT);
  if (d >= 0) {
    const f = brut.indexOf(FIN, d);
    if (f < 0) return { ok: false, erreur: "Bloc incomplet : copie jusqu'à la ligne « " + FIN + " »." };
    const corps = brut.slice(d + DEBUT.length, f).replace(/\s+/g, "");
    if (!corps) return { ok: false, erreur: "Bloc vide : la commande n'a rien trouvé à envoyer." };
    json = corps.startsWith("{") ? corps : base64Texte(corps);
    if (json === null) return { ok: false, erreur: "Bloc abîmé : recopie-le sans le modifier." };
  } else if (brut.startsWith("{")) {
    json = brut;
  } else if (brut.includes(FIN)) {
    return { ok: false, erreur: "Bloc incomplet : copie depuis la ligne « " + DEBUT + " »." };
  } else {
    return { ok: false, erreur: "Ce n'est pas la réponse de la commande : copie tout le bloc, de « " + DEBUT + " » à « " + FIN + " »." };
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json);
  } catch {
    return { ok: false, erreur: "Bloc abîmé : recopie-le sans le modifier." };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, erreur: "Bloc abîmé : recopie-le sans le modifier." };
  if (v.v !== 1) return { ok: false, erreur: "Réponse d'une autre version de SavIDE : recopie la commande de cet écran." };
  const chaine = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const utilisateur = chaine(v.utilisateur);
  if (!utilisateur) return { ok: false, erreur: "Le compte de la machine manque dans la réponse." };
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, erreur: "Port SSH illisible dans la réponse." };
  const liste = (x: unknown) => (Array.isArray(x) ? x : x == null ? [] : [x]);
  const ips = [...new Set(liste(v.ips).map(chaine).filter((ip) => IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip))))];
  const empreintes = liste(v.empreintes)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ type: chaine(e.type), sha256: chaine(e.sha256) }))
    .filter((e) => /^SHA256:[A-Za-z0-9+/]{43}$/.test(e.sha256));
  const cle = v.cle === "oui" || v.cle === "echec" ? v.cle : "non";
  const fiche: FicheAppareil = {
    nom: chaine(v.nom) || ips[0] || "Appareil",
    os: chaine(v.os),
    utilisateur,
    ips,
    port,
    empreintes,
    ssh: typeof v.ssh === "boolean" ? v.ssh : null,
    axecode: chaine(v.axecode) || null,
    cle,
  };
  const msg = chaine(v.cleMessage);
  if (msg) fiche.cleMessage = msg;
  return { ok: true, fiche };
}

/** Ce qui empêchera la connexion, d'après la fiche (vide : rien de connu). */
export function obstacles(f: FicheAppareil, cleDemandee: boolean): string[] {
  const o: string[] = [];
  if (f.ssh === false) o.push(`Le serveur SSH n'écoute pas sur le port ${f.port} de cette machine : active-le d'abord.`);
  if (f.ips.length === 0) o.push("Aucune adresse trouvée : saisis l'adresse de la machine.");
  if (f.empreintes.length === 0) o.push("Aucune clé d'hôte SSH trouvée : son empreinte sera à confirmer au premier test.");
  if (!f.axecode) o.push("SavIDE n'est pas installé sur cette machine : installe-le avant le test.");
  if (cleDemandee && f.cle === "echec") o.push(`La clé de ce PC n'a pas été ajoutée${f.cleMessage ? ` (${f.cleMessage})` : ""}.`);
  return o;
}
