import { EDITION_LOCALE } from "../../lib/edition";
// axe:connexion-google - bouton « Se connecter (Google Axe) » : relance le flux cloud_login existant
// (navigateur systeme, compte @exemple.invalid). Une fois connecte, affiche l'e-mail.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { cloudApi, errorText, type CloudState } from "./cloudApi";

/** Etat de la session Axe Cloud, tenu a jour par l'evenement axe://cloud-state. */
export function useCloudState(): CloudState | null {
  const [etat, setEtat] = useState<CloudState | null>(null);
  useEffect(() => {
    let annule = false;
    let stop: (() => void) | undefined;
    void cloudApi.state().then((s) => { if (!annule) setEtat(s); }).catch(() => undefined);
    void cloudApi
      .onState((s) => { if (!annule) setEtat(s); })
      .then((f) => { if (annule) f(); else stop = f; })
      .catch(() => undefined);
    return () => { annule = true; stop?.(); };
  }, []);
  return etat;
}

export function CloudLoginButton({
  className,
  style,
  barre = false,
}: {
  className?: string;
  style?: React.CSSProperties;
  /** axe:barre-titre — rendu de la barre de titre (sur une ligne, icônes). */
  barre?: boolean;
}) {
  if (EDITION_LOCALE) return null;
  return <CloudLoginButtonCloud className={className} style={style} barre={barre} />;
}

function CloudLoginButtonCloud({
  className,
  style,
  barre = false,
}: {
  className?: string;
  style?: React.CSSProperties;
  barre?: boolean;
}) {
  const etat = useCloudState();
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  if (etat?.connected && barre) {
    // axe:barre-titre — e-mail tronqué (« … », complet au survol) et petit
    // bouton « Se déconnecter » ; en barre étroite, l'icône seule.
    const role = etat.role || "compte";
    return (
      <span className="titlebar__compte" style={style}>
        <span className="titlebar__email" title={`${etat.email} — connecté à Axe Cloud (${role})`}>
          {etat.email}
        </span>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--petit"
          title={`Se déconnecter (${etat.email}) — changer de compte`}
          aria-label="Se déconnecter"
          onClick={() => deconnecter()}
        >
          <Icon icon="solar:logout-2-linear" width={12} height={12} />
          <span className="titlebar__btn-label">Se déconnecter</span>
        </button>
      </span>
    );
  }
  if (etat?.connected) {
    return (
      <span className={className} style={style} title={`Connecté à Axe Cloud (${etat.role || "compte"})`}>
        {etat.email}
        {/* axe:deconnexion - changer de compte */}
        <button type="button" style={{ marginLeft: 6, fontSize: 11, cursor: "pointer", minHeight: 22, padding: "2px 8px" /* axe:accueil-compte - cible de 20 px au moins */ }} title="Se déconnecter (changer de compte)"
          onClick={() => deconnecter()}>
          Se déconnecter
        </button>
      </span>
    );
  }
  const lancer = async () => {
    if (enCours) { void cloudApi.reopenLogin().catch(() => undefined); return; }
    setEnCours(true);
    setErreur(null);
    try {
      await cloudApi.login();
    } catch (err) {
      setErreur(errorText(err));
    } finally {
      setEnCours(false);
    }
  };
  const libelle = enCours ? "Connexion… (navigateur)" : "Se connecter (Google Axe)";
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={() => void lancer()}
      title={erreur ? `Échec : ${erreur}` : enCours ? "Connexion en cours dans le navigateur (cliquer pour rouvrir la page)" : "Se connecter à la VM avec votre compte Google @exemple.invalid"}
      aria-label={barre ? libelle : undefined}
    >
      {barre ? (
        <>
          <Icon icon="solar:login-2-linear" width={12} height={12} />
          <span className="titlebar__btn-label">{libelle}</span>
        </>
      ) : (
        libelle
      )}
    </button>
  );
}

function deconnecter() {
  if (!window.confirm("Se déconnecter d'Axe Cloud ?")) return;
  void cloudApi
    .logout()
    .then(() => window.location.reload())
    .catch((e) => window.alert(String(e)));
}
