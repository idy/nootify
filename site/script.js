"use strict";

const { t } = IdySite;
let currentRelease;
let releaseFailed = false;
const windows = /win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "");
const platforms = {
  mac: { installer: /^Nootify_.+_(?:aarch64|arm64)\.dmg$/i, download: "downloadMac", browse: "macDownloads", missing: "installerMissing" },
  windows: { installer: /^Nootify_.+_x64-setup\.exe$/i, download: "downloadWindows", browse: "windowsDownloads", missing: "windowsInstallerMissing" },
};

function renderRelease() {
  const platform = windows ? platforms.windows : platforms.mac;
  const other = windows ? platforms.mac : platforms.windows;
  const installer = currentRelease && IdySite.asset(currentRelease, platform.installer);
  const otherInstaller = currentRelease && IdySite.asset(currentRelease, other.installer);
  const releaseUrl = currentRelease?.html_url || "https://github.com/idy/nootify/releases";
  for (const link of document.querySelectorAll("[data-download]")) {
    link.href = installer ? installer.browser_download_url : releaseUrl;
    link.textContent = t(installer ? platform.download : "browseReleases");
  }
  for (const link of document.querySelectorAll("[data-download-other]")) {
    link.href = otherInstaller ? otherInstaller.browser_download_url : releaseUrl;
    link.textContent = t(otherInstaller ? other.download : other.browse);
  }
  for (const link of document.querySelectorAll("[data-release-link]")) link.href = releaseUrl;
  for (const node of document.querySelectorAll("[data-release-stage]")) {
    node.textContent = currentRelease ? t(currentRelease.prerelease ? "previewRelease" : "stableRelease") : "GitHub Releases";
  }
  for (const node of document.querySelectorAll("[data-release-version]")) {
    node.textContent = currentRelease?.tag_name || "";
    node.hidden = !currentRelease;
  }
  for (const node of document.querySelectorAll("[data-release-file]")) {
    node.textContent = installer ? `${installer.name} (${(installer.size / 1000000).toFixed(1)} MB)` : "";
    node.hidden = !installer;
  }
  for (const node of document.querySelectorAll("[data-release-status]")) {
    node.textContent = t(releaseFailed ? "releaseUnavailable" : currentRelease
      ? (installer ? "releaseReady" : platform.missing) : "loadingRelease");
  }
}

document.addEventListener("idy:languagechange", renderRelease);
renderRelease();
IdySite.loadRelease("idy/nootify").then(release => {
  currentRelease = release;
}).catch(() => {
  releaseFailed = true;
}).finally(renderRelease);
