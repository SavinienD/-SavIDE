#!/usr/bin/env bash
# CI macOS : Python embarqué UNIVERSEL (arm64 + x86_64) pour l'appli universal-apple-darwin.
# python-build-standalone n'a pas de build universel : on prépare l'arbre arm64 (prepare-python.mjs,
# runner arm64), on télécharge l'arbre x86_64, on y installe les mêmes paquets (wheels x86_64 choisies
# par pip --platform, sans exécuter Python x86_64), puis on fusionne chaque fichier Mach-O avec lipo.
set -euo pipefail
cd "$(dirname "$0")/../.."
RT=src-tauri/binaries/python-runtime
PBS_RELEASE=$(sed -n 's/^const PBS_RELEASE = "\(.*\)";/\1/p' scripts/prepare-python.mjs)
PY_VERSION=$(sed -n 's/^const PY_VERSION = "\(.*\)";/\1/p' scripts/prepare-python.mjs)
PKGS=$(node -e 'const s=require("fs").readFileSync("scripts/prepare-python.mjs","utf8");const m=s.match(/PIP_PACKAGES = \[([\s\S]*?)\];/)[1];console.log([...m.matchAll(/"([^"]+)"/g)].map(x=>x[1]).join(" "))')
PYMM=${PY_VERSION%.*}
echo "Python $PY_VERSION ($PBS_RELEASE) ; paquets : $PKGS"

AXECODE_TARGET_ARCH=arm64 node scripts/prepare-python.mjs --force
lipo -archs "$RT/bin/python$PYMM"

TMPX=$(mktemp -d)
curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/cpython-$PY_VERSION+$PBS_RELEASE-x86_64-apple-darwin-install_only.tar.gz" -o "$TMPX/py.tgz"
tar -xzf "$TMPX/py.tgz" -C "$TMPX"
X86="$TMPX/python"
# shellcheck disable=SC2086
"$RT/bin/python3" -m pip install --disable-pip-version-check --no-warn-script-location --upgrade \
  --target "$X86/lib/python$PYMM/site-packages" --platform macosx_11_0_x86_64 --python-version "$PYMM" \
  --implementation cp --only-binary=:all: $PKGS

python3 - "$RT" "$X86" <<'EOF'
import os, shutil, subprocess, sys
arm, x86 = sys.argv[1], sys.argv[2]
MAGIC = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
def macho(p):
    try:
        with open(p, "rb") as f:
            return f.read(4) in MAGIC
    except OSError:
        return False
def archs(p):
    return subprocess.run(["lipo", "-archs", p], capture_output=True, text=True).stdout.split()
fusion = ajout = 0
for racine, dossiers, fichiers in os.walk(x86):
    rel = os.path.relpath(racine, x86)
    for d in dossiers:
        cible = os.path.join(arm, rel, d)
        if not os.path.lexists(cible) and not os.path.islink(os.path.join(racine, d)):
            os.makedirs(cible, exist_ok=True)
    for nom in fichiers:
        sx = os.path.join(racine, nom); sa = os.path.join(arm, rel, nom)
        if os.path.islink(sx):
            if not os.path.lexists(sa):
                os.symlink(os.readlink(sx), sa)
            continue
        if not macho(sx):
            if not os.path.exists(sa):
                shutil.copy2(sx, sa); ajout += 1
            continue
        if not os.path.exists(sa):
            shutil.copy2(sx, sa); ajout += 1
            continue
        if os.path.islink(sa) or not macho(sa):
            continue
        a = archs(sa)
        if "x86_64" in a:
            continue
        tmp = sa + ".univ"
        subprocess.run(["lipo", "-create", "-output", tmp, sa, sx], check=True)
        shutil.copymode(sa, tmp); os.replace(tmp, sa); fusion += 1
reste = []
for racine, _, fichiers in os.walk(arm):
    for nom in fichiers:
        p = os.path.join(racine, nom)
        if not os.path.islink(p) and macho(p) and set(archs(p)) != {"x86_64", "arm64"}:
            reste.append(os.path.relpath(p, arm))
print(f"fusionnés : {fusion}, ajoutés : {ajout}, non universels : {len(reste)}")
for r in reste[:40]:
    print("  ", r, archs(os.path.join(arm, r)))
EOF
lipo -archs "$RT/bin/python$PYMM"
"$RT/bin/python3" -c "import IPython, dill, openpyxl, docx, pypdf; print('python arm64 OK')"
if arch -x86_64 /usr/bin/true 2>/dev/null; then
  arch -x86_64 "$RT/bin/python3" -c "import IPython, dill, openpyxl, docx, pypdf, platform; print('python', platform.machine(), 'OK')"
else
  echo "Rosetta absente : contrôle x86_64 non exécuté"
fi
rm -rf "$TMPX"
