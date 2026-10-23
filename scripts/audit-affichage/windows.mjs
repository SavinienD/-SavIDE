// Le PC de l'utilisateur est sous Windows (WebView2 = Chromium) : l'appli y dessine
// ses propres boutons de fenetre. On presente donc la page comme Windows.
export const UA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

export async function emulerWindows(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: UA_WINDOWS,
    platform: "Win32",
    acceptLanguage: "fr-FR,fr",
    userAgentMetadata: {
      brands: [{ brand: "Microsoft Edge WebView2", version: "141" }, { brand: "Chromium", version: "141" }],
      fullVersion: "141.0.0.0",
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
    },
  });
  return cdp;
}
