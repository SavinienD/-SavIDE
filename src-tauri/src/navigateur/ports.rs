//! Ports ouverts par les serveurs du dossier (liste « Ports » de l'onglet Navigateur).
//!
//! Un port en écoute est retenu quand son processus a été lancé sous le dossier
//! (dossier courant dedans) ou depuis un terminal de l'appli pour ce dossier (variable
//! `AXECODE_WORKSPACE` héritée du terminal). Seuls les processus de l'utilisateur sont
//! lisibles : rien d'autre n'est montré.
//! - Linux : `/proc/net/tcp{,6}`, puis `/proc/<pid>/fd`, `cwd`, `environ`, `comm`.
//! - Windows : `GetExtendedTcpTable` (propriétaire de chaque port), puis le dossier
//!   courant et l'environnement lus dans le PEB du processus (comme psutil).
//! - macOS : `lsof` (ports et dossier courant ; l'environnement n'y est pas lisible).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

/// Variable posée par les terminaux de l'appli (`terminal.rs`) et héritée par leurs processus.
pub(crate) const VARIABLE_DOSSIER: &str = "AXECODE_WORKSPACE";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortOuvert {
    pub(crate) port: u16,
    /// Adresse d'écoute : « 127.0.0.1 », « 0.0.0.0 », « :: »…
    pub(crate) adresse: String,
    pub(crate) pid: u32,
    pub(crate) processus: String,
    /// Adresse à ouvrir dans le navigateur intégré.
    pub(crate) url: String,
}

/// Un port en écoute et son processus, avant le tri par dossier.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Ecoute {
    pub(crate) port: u16,
    pub(crate) adresse: String,
    pub(crate) pid: u32,
}

/// Ce qu'on sait d'un processus pour le rattacher à un dossier.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct InfoProcessus {
    pub(crate) nom: String,
    pub(crate) dossier_courant: Option<String>,
    pub(crate) variable_dossier: Option<String>,
}

fn propre(chemin: &str) -> String {
    let s = chemin.trim().replace('\\', "/");
    let s = s.trim_start_matches("//?/").trim_end_matches('/').to_string();
    if cfg!(windows) || s.chars().nth(1) == Some(':') {
        s.to_lowercase()
    } else {
        s
    }
}

/// Vrai si `chemin` est `dossier` ou un de ses sous-dossiers (« /a/projet2 » n'est pas dans « /a/projet »).
pub(crate) fn dans_le_dossier(chemin: &str, dossier: &str) -> bool {
    let (c, d) = (propre(chemin), propre(dossier));
    !d.is_empty() && (c == d || c.starts_with(&format!("{d}/")))
}

/// Vrai si le processus appartient au dossier (lancé dessous ou depuis un de ses terminaux).
pub(crate) fn du_dossier(info: &InfoProcessus, dossier: &str) -> bool {
    info.dossier_courant.as_deref().is_some_and(|c| dans_le_dossier(c, dossier))
        || info.variable_dossier.as_deref().is_some_and(|v| dans_le_dossier(v, dossier))
}

/// Tri par dossier, un port une seule fois (IPv4 et IPv6 du même serveur), ordre croissant.
pub(crate) fn retenir(
    ecoutes: Vec<Ecoute>,
    infos: &HashMap<u32, InfoProcessus>,
    dossier: &str,
    moi: u32,
) -> Vec<PortOuvert> {
    let mut retenus: BTreeMap<u16, PortOuvert> = BTreeMap::new();
    for e in ecoutes {
        if e.pid == moi || e.pid == 0 {
            continue;
        }
        let Some(info) = infos.get(&e.pid) else { continue };
        if !du_dossier(info, dossier) {
            continue;
        }
        retenus.entry(e.port).or_insert_with(|| PortOuvert {
            port: e.port,
            adresse: e.adresse.clone(),
            pid: e.pid,
            processus: info.nom.clone(),
            url: super::adresse::adresse_du_port(e.port),
        });
    }
    retenus.into_values().collect()
}

/// Ports des serveurs du dossier `dossier` (vide si le système ne permet pas de les lire).
pub(crate) fn lister(dossier: &str) -> Vec<PortOuvert> {
    if dossier.trim().is_empty() || !Path::new(dossier).is_dir() {
        return Vec::new();
    }
    let (ecoutes, infos) = systeme::relever();
    retenir(ecoutes, &infos, dossier, std::process::id())
}

/// Linux : lignes de `/proc/net/tcp` ou `tcp6` → (port, adresse, inode) des sockets en écoute.
pub(crate) fn lire_table_proc(texte: &str, ipv6: bool) -> Vec<(u16, String, u64)> {
    texte
        .lines()
        .skip(1)
        .filter_map(|ligne| {
            let champs: Vec<&str> = ligne.split_whitespace().collect();
            if champs.len() < 10 || champs[3] != "0A" {
                return None;
            }
            let (adresse_hex, port_hex) = champs[1].split_once(':')?;
            let port = u16::from_str_radix(port_hex, 16).ok()?;
            let inode = champs[9].parse::<u64>().ok()?;
            Some((port, adresse_proc(adresse_hex, ipv6), inode))
        })
        .collect()
}

fn adresse_proc(hex: &str, ipv6: bool) -> String {
    let octets: Vec<u8> = (0..hex.len() / 2).filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect();
    if !ipv6 && octets.len() == 4 {
        // Mot de 32 bits en ordre de la machine (petit-boutiste sur x86 et ARM).
        return std::net::Ipv4Addr::new(octets[3], octets[2], octets[1], octets[0]).to_string();
    }
    if ipv6 && octets.len() == 16 {
        let mut ordre = [0u8; 16];
        for mot in 0..4 {
            for i in 0..4 {
                ordre[mot * 4 + i] = octets[mot * 4 + 3 - i];
            }
        }
        return std::net::Ipv6Addr::from(ordre).to_string();
    }
    hex.to_string()
}

/// macOS : sortie de `lsof -F pcn` → écoutes et noms des processus.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn lire_lsof_ecoutes(texte: &str) -> (Vec<Ecoute>, HashMap<u32, String>) {
    let mut ecoutes = Vec::new();
    let mut noms = HashMap::new();
    let mut pid = 0u32;
    for ligne in texte.lines() {
        let (cle, valeur) = ligne.split_at(ligne.len().min(1));
        match cle {
            "p" => pid = valeur.parse().unwrap_or(0),
            "c" => {
                noms.insert(pid, valeur.to_string());
            }
            "n" => {
                if let Some((adresse, port)) = valeur.rsplit_once(':') {
                    if let Ok(port) = port.parse::<u16>() {
                        let adresse = adresse.trim_start_matches('[').trim_end_matches(']');
                        let adresse = if adresse == "*" { "0.0.0.0" } else { adresse };
                        ecoutes.push(Ecoute { port, adresse: adresse.to_string(), pid });
                    }
                }
            }
            _ => {}
        }
    }
    (ecoutes, noms)
}

/// macOS : sortie de `lsof -a -d cwd -F pn -p …` → dossier courant de chaque processus.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn lire_lsof_dossiers(texte: &str) -> HashMap<u32, String> {
    let mut dossiers = HashMap::new();
    let mut pid = 0u32;
    for ligne in texte.lines() {
        if let Some(p) = ligne.strip_prefix('p') {
            pid = p.parse().unwrap_or(0);
        } else if let Some(n) = ligne.strip_prefix('n') {
            dossiers.insert(pid, n.to_string());
        }
    }
    dossiers
}

/// Valeur de `VARIABLE_DOSSIER` dans un bloc d'environnement (`NOM=valeur` séparés par NUL).
pub(crate) fn variable_dans(bloc: &str) -> Option<String> {
    bloc.split('\0')
        .find_map(|entree| entree.strip_prefix(VARIABLE_DOSSIER).and_then(|reste| reste.strip_prefix('=')))
        .map(str::to_string)
        .filter(|v| !v.is_empty())
}

#[cfg(target_os = "linux")]
mod systeme {
    use super::*;
    use std::fs;

    pub(super) fn relever() -> (Vec<Ecoute>, HashMap<u32, InfoProcessus>) {
        let mut sockets: HashMap<u64, (u16, String)> = HashMap::new();
        for (fichier, ipv6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
            if let Ok(texte) = fs::read_to_string(fichier) {
                for (port, adresse, inode) in lire_table_proc(&texte, ipv6) {
                    sockets.insert(inode, (port, adresse));
                }
            }
        }
        let mut ecoutes = Vec::new();
        let mut infos = HashMap::new();
        if sockets.is_empty() {
            return (ecoutes, infos);
        }
        let Ok(processus) = fs::read_dir("/proc") else { return (ecoutes, infos) };
        for entree in processus.flatten() {
            let Some(pid) = entree.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            let racine = entree.path();
            // Dossier des descripteurs illisible : processus d'un autre utilisateur.
            let Ok(descripteurs) = fs::read_dir(racine.join("fd")) else { continue };
            let mut trouve = false;
            for fd in descripteurs.flatten() {
                let Ok(cible) = fs::read_link(fd.path()) else { continue };
                let cible = cible.to_string_lossy();
                let Some(inode) = cible.strip_prefix("socket:[").and_then(|r| r.strip_suffix(']')).and_then(|n| n.parse::<u64>().ok()) else {
                    continue;
                };
                if let Some((port, adresse)) = sockets.get(&inode) {
                    ecoutes.push(Ecoute { port: *port, adresse: adresse.clone(), pid });
                    trouve = true;
                }
            }
            if trouve {
                let environ = fs::read(racine.join("environ")).map(|o| String::from_utf8_lossy(&o).to_string()).unwrap_or_default();
                infos.insert(
                    pid,
                    InfoProcessus {
                        nom: fs::read_to_string(racine.join("comm")).map(|n| n.trim().to_string()).unwrap_or_default(),
                        dossier_courant: fs::read_link(racine.join("cwd")).ok().map(|c| c.to_string_lossy().to_string()),
                        variable_dossier: variable_dans(&environ),
                    },
                );
            }
        }
        (ecoutes, infos)
    }
}

#[cfg(target_os = "macos")]
mod systeme {
    use super::*;
    use std::process::{Command, Stdio};

    fn lsof(arguments: &[&str]) -> String {
        Command::new("lsof")
            .args(arguments)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    }

    pub(super) fn relever() -> (Vec<Ecoute>, HashMap<u32, InfoProcessus>) {
        let (ecoutes, noms) = lire_lsof_ecoutes(&lsof(&["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]));
        let mut pids: Vec<String> = ecoutes.iter().map(|e| e.pid.to_string()).collect();
        pids.sort();
        pids.dedup();
        let dossiers = if pids.is_empty() {
            HashMap::new()
        } else {
            lire_lsof_dossiers(&lsof(&["-a", "-d", "cwd", "-F", "pn", "-p", &pids.join(",")]))
        };
        let infos = noms
            .into_iter()
            .map(|(pid, nom)| {
                (pid, InfoProcessus { nom, dossier_courant: dossiers.get(&pid).cloned(), variable_dossier: None })
            })
            .collect();
        (ecoutes, infos)
    }
}

#[cfg(windows)]
mod systeme {
    use super::*;
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Threading::{
        IsWow64Process, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    /// Table des ports en écoute d'une famille (2 = IPv4, 23 = IPv6), en mots de 32 bits.
    fn table(famille: u32) -> Vec<u32> {
        let mut taille = 0u32;
        unsafe { GetExtendedTcpTable(None, &mut taille, false, famille, TCP_TABLE_OWNER_PID_LISTENER, 0) };
        for _ in 0..3 {
            let mut tampon = vec![0u32; (taille as usize / 4) + 64];
            let mut capacite = (tampon.len() * 4) as u32;
            let code = unsafe {
                GetExtendedTcpTable(Some(tampon.as_mut_ptr() as *mut c_void), &mut capacite, false, famille, TCP_TABLE_OWNER_PID_LISTENER, 0)
            };
            if code == 0 {
                return tampon;
            }
            taille = capacite;
        }
        Vec::new()
    }

    fn lignes<T: Copy>(tampon: &[u32]) -> Vec<T> {
        let Some(&nombre) = tampon.first() else { return Vec::new() };
        let octets = tampon.len() * 4;
        let nombre = (nombre as usize).min(octets.saturating_sub(4) / size_of::<T>());
        let debut = unsafe { (tampon.as_ptr() as *const u8).add(4) as *const T };
        (0..nombre).map(|i| unsafe { std::ptr::read_unaligned(debut.add(i)) }).collect()
    }

    fn ecoutes() -> Vec<Ecoute> {
        let mut sortie = Vec::new();
        for ligne in lignes::<MIB_TCPROW_OWNER_PID>(&table(2)) {
            sortie.push(Ecoute {
                port: u16::from_be(ligne.dwLocalPort as u16),
                adresse: std::net::Ipv4Addr::from(ligne.dwLocalAddr.to_ne_bytes()).to_string(),
                pid: ligne.dwOwningPid,
            });
        }
        for ligne in lignes::<MIB_TCP6ROW_OWNER_PID>(&table(23)) {
            sortie.push(Ecoute {
                port: u16::from_be(ligne.dwLocalPort as u16),
                adresse: std::net::Ipv6Addr::from(ligne.ucLocalAddr).to_string(),
                pid: ligne.dwOwningPid,
            });
        }
        sortie
    }

    fn nom(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut tampon = [0u16; 1024];
            let mut taille = tampon.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(tampon.as_mut_ptr()), &mut taille).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return String::new();
            }
            let chemin = String::from_utf16_lossy(&tampon[..taille as usize]);
            chemin.rsplit(['\\', '/']).next().unwrap_or("").to_string()
        }
    }

    /// Informations de base du processus (NtQueryInformationProcess, classe 0).
    #[repr(C)]
    #[derive(Default)]
    struct InfoBase {
        statut: i32,
        peb: usize,
        affinite: usize,
        priorite: i32,
        pid: usize,
        parent: usize,
    }

    unsafe fn lire<T: Copy>(h: HANDLE, adresse: usize) -> Option<T> {
        let mut valeur = MaybeUninit::<T>::uninit();
        unsafe { ReadProcessMemory(h, adresse as *const c_void, valeur.as_mut_ptr() as *mut c_void, size_of::<T>(), None).ok()? };
        Some(unsafe { valeur.assume_init() })
    }

    unsafe fn lire_utf16(h: HANDLE, adresse: usize, caracteres: usize) -> Option<String> {
        if adresse == 0 || caracteres == 0 || caracteres > 32_768 {
            return None;
        }
        let mut tampon = vec![0u16; caracteres];
        unsafe {
            ReadProcessMemory(h, adresse as *const c_void, tampon.as_mut_ptr() as *mut c_void, caracteres * 2, None).ok()?;
        }
        Some(String::from_utf16_lossy(&tampon))
    }

    /// Dossier courant et `AXECODE_WORKSPACE` d'un processus 64 bits, lus dans son PEB
    /// (RTL_USER_PROCESS_PARAMETERS : dossier courant en 0x38, environnement en 0x80).
    #[cfg(target_pointer_width = "64")]
    fn dossier_et_variable(pid: u32) -> (Option<String>, Option<String>) {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) else { return (None, None) };
            let resultat = (|| {
                let mut wow64 = windows::core::BOOL(0);
                if IsWow64Process(h, &mut wow64).is_err() || wow64.as_bool() {
                    return None;
                }
                let mut base = InfoBase::default();
                let statut = NtQueryInformationProcess(
                    h,
                    ProcessBasicInformation,
                    &mut base as *mut InfoBase as *mut c_void,
                    size_of::<InfoBase>() as u32,
                    std::ptr::null_mut(),
                );
                if statut.0 < 0 || base.peb == 0 {
                    return None;
                }
                let parametres: usize = lire(h, base.peb + 0x20)?;
                let longueur: u16 = lire(h, parametres + 0x38)?;
                let tampon: usize = lire(h, parametres + 0x40)?;
                let dossier = lire_utf16(h, tampon, longueur as usize / 2);
                let environnement: usize = lire(h, parametres + 0x80)?;
                let variable = [32_768usize, 16_384, 8_192, 4_096, 2_048, 1_024]
                    .iter()
                    .find_map(|&n| lire_utf16(h, environnement, n / 2))
                    .and_then(|bloc| variable_dans(&bloc));
                Some((dossier, variable))
            })();
            let _ = CloseHandle(h);
            resultat.unwrap_or((None, None))
        }
    }

    #[cfg(not(target_pointer_width = "64"))]
    fn dossier_et_variable(_pid: u32) -> (Option<String>, Option<String>) {
        (None, None)
    }

    pub(super) fn relever() -> (Vec<Ecoute>, HashMap<u32, InfoProcessus>) {
        let ecoutes = ecoutes();
        let mut infos = HashMap::new();
        for e in &ecoutes {
            if e.pid == 0 || e.pid == 4 || infos.contains_key(&e.pid) {
                continue;
            }
            let (dossier_courant, variable_dossier) = dossier_et_variable(e.pid);
            infos.insert(e.pid, InfoProcessus { nom: nom(e.pid), dossier_courant, variable_dossier });
        }
        (ecoutes, infos)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod systeme {
    use super::*;

    pub(super) fn relever() -> (Vec<Ecoute>, HashMap<u32, InfoProcessus>) {
        (Vec::new(), HashMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dossier_et_sous_dossiers() {
        assert!(dans_le_dossier("/home/a/projet", "/home/a/projet/"));
        assert!(dans_le_dossier("/home/a/projet/web", "/home/a/projet"));
        assert!(!dans_le_dossier("/home/a/projet2", "/home/a/projet"));
        assert!(dans_le_dossier("C:\\Users\\Sav\\Projet\\web", "c:/users/sav/projet"));
        assert!(!dans_le_dossier("/x", ""));
    }

    #[test]
    fn table_proc_ipv4_et_ipv6() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0\n   1: 0100007F:0016 0200007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 99 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(lire_table_proc(tcp, false), vec![(8080, "127.0.0.1".to_string(), 123456)]);
        let tcp6 = "  sl  local_address                         remote_address                        st\n   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1\n";
        assert_eq!(lire_table_proc(tcp6, true), vec![(5173, "::1".to_string(), 777)]);
    }

    #[test]
    fn sorties_de_lsof() {
        let (ecoutes, noms) = lire_lsof_ecoutes("p812\ncnode\nn*:5173\nn[::1]:5173\np90\ncpython3\nn127.0.0.1:8000\n");
        assert_eq!(ecoutes.len(), 3);
        assert_eq!(ecoutes[0], Ecoute { port: 5173, adresse: "0.0.0.0".into(), pid: 812 });
        assert_eq!(ecoutes[1].adresse, "::1");
        assert_eq!(noms.get(&90).map(String::as_str), Some("python3"));
        let dossiers = lire_lsof_dossiers("p812\nfcwd\nn/Users/a/site\np90\nfcwd\nn/tmp\n");
        assert_eq!(dossiers.get(&812).map(String::as_str), Some("/Users/a/site"));
    }

    #[test]
    fn variable_du_terminal() {
        assert_eq!(variable_dans("PATH=/bin\0AXECODE_WORKSPACE=/home/a/p\0TERM=x\0\0").as_deref(), Some("/home/a/p"));
        assert_eq!(variable_dans("AXECODE_WORKSPACE_X=1\0"), None);
        assert_eq!(variable_dans(""), None);
    }

    #[test]
    fn retenus_par_dossier_un_port_une_fois() {
        let ecoutes = vec![
            Ecoute { port: 5173, adresse: "127.0.0.1".into(), pid: 10 },
            Ecoute { port: 5173, adresse: "::1".into(), pid: 10 },
            Ecoute { port: 3000, adresse: "0.0.0.0".into(), pid: 11 },
            Ecoute { port: 8080, adresse: "0.0.0.0".into(), pid: 12 },
            Ecoute { port: 9000, adresse: "127.0.0.1".into(), pid: 99 },
        ];
        let mut infos = HashMap::new();
        infos.insert(10, InfoProcessus { nom: "node".into(), dossier_courant: Some("/p/web".into()), variable_dossier: None });
        infos.insert(11, InfoProcessus { nom: "python3".into(), dossier_courant: Some("/tmp".into()), variable_dossier: Some("/p".into()) });
        infos.insert(12, InfoProcessus { nom: "autre".into(), dossier_courant: Some("/ailleurs".into()), variable_dossier: None });
        infos.insert(99, InfoProcessus { nom: "moi".into(), dossier_courant: Some("/p".into()), variable_dossier: None });
        let ports = retenir(ecoutes, &infos, "/p", 99);
        let vus: Vec<(u16, &str)> = ports.iter().map(|p| (p.port, p.processus.as_str())).collect();
        assert_eq!(vus, vec![(3000, "python3"), (5173, "node")]);
        assert_eq!(ports[1].url, "http://localhost:5173/");
        assert_eq!(ports[1].adresse, "127.0.0.1");
    }

    /// Vrai serveur lancé dans un dossier temporaire, puis depuis « un terminal » (variable).
    #[cfg(target_os = "linux")]
    #[test]
    fn serveurs_reels_du_dossier() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let racine = std::env::temp_dir().join(format!("axecode-ports-{}", std::process::id()));
        let (a, b) = (racine.join("projet"), racine.join("terminal"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let lancer = |dossier: &std::path::Path, variable: Option<&std::path::Path>| {
            let mut commande = Command::new("python3");
            commande
                .args(["-c", "import socket,time\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen()\nprint(s.getsockname()[1],flush=True)\ntime.sleep(30)"])
                .current_dir(dossier)
                .stdout(Stdio::piped())
                .stdin(Stdio::null());
            if let Some(v) = variable {
                commande.env(VARIABLE_DOSSIER, v);
            }
            let mut enfant = commande.spawn().expect("python3");
            let mut ligne = String::new();
            BufReader::new(enfant.stdout.take().unwrap()).read_line(&mut ligne).unwrap();
            (enfant, ligne.trim().parse::<u16>().unwrap())
        };
        let (mut serveur_a, port_a) = lancer(&a, None);
        let (mut serveur_b, port_b) = lancer(&std::env::temp_dir(), Some(&b));
        let ports_a: Vec<u16> = lister(&a.to_string_lossy()).iter().map(|p| p.port).collect();
        let ports_b: Vec<u16> = lister(&b.to_string_lossy()).iter().map(|p| p.port).collect();
        let _ = serveur_a.kill();
        let _ = serveur_b.kill();
        let _ = serveur_a.wait();
        let _ = serveur_b.wait();
        let _ = std::fs::remove_dir_all(&racine);
        assert!(ports_a.contains(&port_a), "{ports_a:?} sans {port_a}");
        assert!(!ports_a.contains(&port_b), "{ports_a:?} contient {port_b}");
        assert!(ports_b.contains(&port_b), "{ports_b:?} sans {port_b}");
    }
}
