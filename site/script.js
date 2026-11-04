"use strict";

const { t } = IdySite;
let currentRelease;
let releaseFailed = false;

function renderRelease() {
  const installer = currentRelease && IdySite.asset(currentRelease, /^Nootify_.+_(?:aarch64|arm64)\.dmg$/i);
  const releaseUrl = currentRelease?.html_url || "https://github.com/idy/nootify/releases";
  for (const link of document.querySelectorAll("[data-download]")) {
    link.href = installer ? installer.browser_download_url : releaseUrl;
    link.textContent = t(installer ? "downloadMac" : "browseReleases");
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
      ? (installer ? "releaseReady" : "installerMissing") : "loadingRelease");
  }
}

document.addEventListener("idy:languagechange", renderRelease);
renderRelease();
IdySite.loadRelease("idy/nootify").then(release => {
  currentRelease = release;
}).catch(() => {
  releaseFailed = true;
}).finally(renderRelease);
