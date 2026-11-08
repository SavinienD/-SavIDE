// QR code fabriqué dans l'appli, sans réseau (avant : image demandée à un site
// tiers, qui recevait l'adresse du relais et le code d'appairage).
// Norme ISO/IEC 18004 : mode octet (UTF-8), versions 1 à 40, correction L/M/Q/H.
// Organisation du calcul d'après le générateur QR de Nayuki (MIT).

export type NiveauCorrection = "L" | "M" | "Q" | "H";

const RANG: Record<NiveauCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Bits de format du niveau (L=01, M=00, Q=11, H=10). */
const BITS_NIVEAU: Record<NiveauCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Octets de correction par bloc et nombre de blocs, par niveau puis par version (index 0 inutilisé).
const CORRECTION_PAR_BLOC: number[][] = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NOMBRE_DE_BLOCS: number[][] = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export type QrCode = {
  version: number;
  masque: number;
  taille: number;
  /** modules[ligne][colonne] : true = foncé. */
  modules: boolean[][];
};

function bit(valeur: number, rang: number): boolean {
  return ((valeur >>> rang) & 1) !== 0;
}

/** Nombre de modules qui portent des données (et correction) pour une version. */
function modulesDeDonnees(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignements = Math.floor(version / 7) + 2;
    n -= (25 * alignements - 10) * alignements - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function octetsDeDonnees(version: number, niveau: NiveauCorrection): number {
  const r = RANG[niveau];
  return Math.floor(modulesDeDonnees(version) / 8) - CORRECTION_PAR_BLOC[r][version] * NOMBRE_DE_BLOCS[r][version];
}

// ── Reed-Solomon sur GF(256), polynôme 0x11D ────────────────────────────────
function multiplier(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function diviseur(degre: number): number[] {
  const coefs = new Array<number>(degre).fill(0);
  coefs[degre - 1] = 1;
  let racine = 1;
  for (let i = 0; i < degre; i++) {
    for (let j = 0; j < degre; j++) {
      coefs[j] = multiplier(coefs[j], racine);
      if (j + 1 < degre) coefs[j] ^= coefs[j + 1];
    }
    racine = multiplier(racine, 0x02);
  }
  return coefs;
}

function reste(donnees: number[], div: number[]): number[] {
  const r = div.map(() => 0);
  for (const octet of donnees) {
    const facteur = octet ^ (r.shift() as number);
    r.push(0);
    for (let i = 0; i < div.length; i++) r[i] ^= multiplier(div[i], facteur);
  }
  return r;
}

/** Découpe en blocs, ajoute la correction, entrelace. */
function avecCorrection(donnees: number[], version: number, niveau: NiveauCorrection): number[] {
  const r = RANG[niveau];
  const blocs = NOMBRE_DE_BLOCS[r][version];
  const correction = CORRECTION_PAR_BLOC[r][version];
  const brut = Math.floor(modulesDeDonnees(version) / 8);
  const courts = blocs - (brut % blocs);
  const longueurCourte = Math.floor(brut / blocs);
  const div = diviseur(correction);
  const liste: number[][] = [];
  for (let i = 0, k = 0; i < blocs; i++) {
    const morceau = donnees.slice(k, k + longueurCourte - correction + (i < courts ? 0 : 1));
    k += morceau.length;
    const ecc = reste(morceau, div);
    if (i < courts) morceau.push(0);
    liste.push(morceau.concat(ecc));
  }
  const sortie: number[] = [];
  for (let i = 0; i < liste[0].length; i++) {
    liste.forEach((bloc, j) => {
      if (i !== longueurCourte - correction || j >= courts) sortie.push(bloc[i]);
    });
  }
  return sortie;
}

function positionsAlignement(version: number): number[] {
  if (version === 1) return [];
  const nombre = Math.floor(version / 7) + 2;
  const pas = Math.floor((version * 8 + nombre * 3 + 5) / (nombre * 4 - 4)) * 2;
  const positions = [6];
  for (let p = version * 4 + 10; positions.length < nombre; p -= pas) positions.splice(1, 0, p);
  return positions;
}

class Grille {
  readonly taille: number;
  readonly modules: boolean[][];
  readonly fixes: boolean[][];

  constructor(readonly version: number) {
    this.taille = version * 4 + 17;
    this.modules = Array.from({ length: this.taille }, () => new Array<boolean>(this.taille).fill(false));
    this.fixes = Array.from({ length: this.taille }, () => new Array<boolean>(this.taille).fill(false));
  }

  fixer(x: number, y: number, fonce: boolean) {
    this.modules[y][x] = fonce;
    this.fixes[y][x] = true;
  }

  motifsFixes(niveau: NiveauCorrection) {
    const t = this.taille;
    for (let i = 0; i < t; i++) {
      this.fixer(6, i, i % 2 === 0);
      this.fixer(i, 6, i % 2 === 0);
    }
    this.reperePosition(3, 3);
    this.reperePosition(t - 4, 3);
    this.reperePosition(3, t - 4);
    const pos = positionsAlignement(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const coin = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (!coin) this.repereAlignement(pos[i], pos[j]);
      }
    }
    this.format(niveau, 0);
    this.infoVersion();
  }

  reperePosition(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.taille && yy >= 0 && yy < this.taille) this.fixer(xx, yy, d !== 2 && d !== 4);
      }
    }
  }

  repereAlignement(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.fixer(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  format(niveau: NiveauCorrection, masque: number) {
    const donnees = (BITS_NIVEAU[niveau] << 3) | masque;
    let r = donnees;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((donnees << 10) | r) ^ 0x5412;
    const t = this.taille;
    for (let i = 0; i <= 5; i++) this.fixer(8, i, bit(bits, i));
    this.fixer(8, 7, bit(bits, 6));
    this.fixer(8, 8, bit(bits, 7));
    this.fixer(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.fixer(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.fixer(t - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.fixer(8, t - 15 + i, bit(bits, i));
    this.fixer(8, t - 8, true);
  }

  infoVersion() {
    if (this.version < 7) return;
    let r = this.version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (this.version << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = this.taille - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.fixer(a, b, bit(bits, i));
      this.fixer(b, a, bit(bits, i));
    }
  }

  placer(octets: number[]) {
    const t = this.taille;
    let i = 0;
    for (let droite = t - 1; droite >= 1; droite -= 2) {
      if (droite === 6) droite = 5;
      for (let v = 0; v < t; v++) {
        for (let j = 0; j < 2; j++) {
          const x = droite - j;
          const montant = ((droite + 1) & 2) === 0;
          const y = montant ? t - 1 - v : v;
          if (!this.fixes[y][x] && i < octets.length * 8) {
            this.modules[y][x] = bit(octets[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  masquer(masque: number) {
    for (let y = 0; y < this.taille; y++) {
      for (let x = 0; x < this.taille; x++) {
        if (this.fixes[y][x]) continue;
        let inverse: boolean;
        switch (masque) {
          case 0: inverse = (x + y) % 2 === 0; break;
          case 1: inverse = y % 2 === 0; break;
          case 2: inverse = x % 3 === 0; break;
          case 3: inverse = (x + y) % 3 === 0; break;
          case 4: inverse = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inverse = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inverse = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inverse = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (inverse) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Pénalité de la norme (suites, carrés 2×2, faux repères, équilibre clair/foncé). */
  penalite(): number {
    const t = this.taille;
    let score = 0;
    for (let y = 0; y < t; y++) score += penaliteSuite(t, (x) => this.modules[y][x]);
    for (let x = 0; x < t; x++) score += penaliteSuite(t, (y) => this.modules[y][x]);
    let fonces = 0;
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        const c = this.modules[y][x];
        if (c) fonces++;
        if (x < t - 1 && y < t - 1 && c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) score += 3;
      }
    }
    const total = t * t;
    score += (Math.ceil(Math.abs(fonces * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** Règles 1 et 3 sur une ligne ou une colonne (le bord compte comme clair). */
function penaliteSuite(t: number, lire: (i: number) => boolean): number {
  let score = 0;
  let couleur = false;
  let longueur = 0;
  const historique = [0, 0, 0, 0, 0, 0, 0];
  const ajouter = (n: number) => {
    historique.pop();
    historique.unshift(historique[0] === 0 ? n + t : n);
  };
  const fauxReperes = () => {
    const n = historique[1];
    const coeur = n > 0 && historique[2] === n && historique[3] === n * 3 && historique[4] === n && historique[5] === n;
    return (coeur && historique[0] >= n * 4 && historique[6] >= n ? 1 : 0) + (coeur && historique[6] >= n * 4 && historique[0] >= n ? 1 : 0);
  };
  for (let i = 0; i < t; i++) {
    const c = lire(i);
    if (c === couleur) {
      longueur++;
      if (longueur === 5) score += 3;
      else if (longueur > 5) score++;
    } else {
      ajouter(longueur);
      if (!couleur) score += fauxReperes() * 40;
      couleur = c;
      longueur = 1;
    }
  }
  if (couleur) {
    ajouter(longueur);
    longueur = 0;
  }
  ajouter(longueur + t);
  return score + fauxReperes() * 40;
}

/**
 * Fabrique le QR code d'un texte (UTF-8, mode octet), dans la plus petite version possible.
 * `masqueImpose` (0 à 7) sert aux tests ; sinon le masque de plus faible pénalité est choisi.
 */
export function fabriquerQr(texte: string, niveau: NiveauCorrection = "M", masqueImpose?: number): QrCode {
  const octets = Array.from(new TextEncoder().encode(texte));
  let version = 1;
  while (4 + (version <= 9 ? 8 : 16) + octets.length * 8 > octetsDeDonnees(version, niveau) * 8) {
    version++;
    if (version > 40) throw new Error("texte trop long pour un QR code");
  }
  const capacite = octetsDeDonnees(version, niveau);
  const bits: number[] = [];
  const ecrire = (valeur: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((valeur >>> i) & 1);
  };
  ecrire(0b0100, 4);
  ecrire(octets.length, version <= 9 ? 8 : 16);
  for (const o of octets) ecrire(o, 8);
  ecrire(0, Math.min(4, capacite * 8 - bits.length));
  ecrire(0, (8 - (bits.length % 8)) % 8);
  const donnees: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let o = 0;
    for (let j = 0; j < 8; j++) o = (o << 1) | bits[i + j];
    donnees.push(o);
  }
  for (let bourrage = 0xec; donnees.length < capacite; bourrage ^= 0xec ^ 0x11) donnees.push(bourrage);

  const grille = new Grille(version);
  grille.motifsFixes(niveau);
  grille.placer(avecCorrection(donnees, version, niveau));
  let masque = masqueImpose ?? -1;
  if (masque < 0 || masque > 7) {
    let meilleur = Infinity;
    for (let m = 0; m < 8; m++) {
      grille.masquer(m);
      grille.format(niveau, m);
      const p = grille.penalite();
      if (p < meilleur) {
        meilleur = p;
        masque = m;
      }
      grille.masquer(m);
    }
  }
  grille.masquer(masque);
  grille.format(niveau, masque);
  return { version, masque, taille: grille.taille, modules: grille.modules };
}

/** Chemin SVG des modules foncés (une ligne horizontale par suite), avec `marge` modules clairs autour. */
export function cheminSvg(qr: QrCode, marge = 4): { cote: number; chemin: string } {
  const parties: string[] = [];
  qr.modules.forEach((ligne, y) => {
    for (let x = 0; x < qr.taille; ) {
      if (!ligne[x]) {
        x++;
        continue;
      }
      let fin = x;
      while (fin < qr.taille && ligne[fin]) fin++;
      parties.push(`M${x + marge} ${y + marge}h${fin - x}v1h${x - fin}z`);
      x = fin;
    }
  });
  return { cote: qr.taille + 2 * marge, chemin: parties.join("") };
}
