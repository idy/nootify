/* Shared idy.dev header controls. Keep this file in sync across sites. */
(() => {
  "use strict";

  document.addEventListener("DOMContentLoaded", () => {
    if (!window.IdySite) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    for (const header of document.querySelectorAll(".compact-header")) {
      const native = header.querySelector(".idy-preferences");
      const selects = ["theme", "language"].map(kind => native?.querySelector(`[data-idy-${kind}]`));
      if (selects.some(select => !select)) continue;
      const controls = document.createElement("div");
      controls.className = "header-controls";
      let opened;
      const menus = [];
      const mobile = header.querySelector(".idy-mobile");
      const mobileSummary = mobile?.querySelector("summary");
      const icon = name => {
        const node = document.createElement("i");
        node.className = `ph ph-${name}`;
        node.setAttribute("aria-hidden", "true");
        return node;
      };
      const close = restoreFocus => {
        if (!opened) return;
        const menu = opened;
        opened = undefined;
        menu.panel.hidden = true;
        menu.trigger.setAttribute("aria-expanded", "false");
        if (restoreFocus) menu.trigger.focus();
      };
      const place = panel => {
        panel.style.transform = "";
        const bounds = panel.getBoundingClientRect();
        if (bounds.left < 12) panel.style.transform = `translateX(${12 - bounds.left}px)`;
        else if (bounds.right > innerWidth - 12) panel.style.transform = `translateX(${innerWidth - 12 - bounds.right}px)`;
      };
      const open = menu => {
        close(false);
        if (mobile) mobile.open = false;
        opened = menu;
        menu.panel.hidden = false;
        menu.trigger.setAttribute("aria-expanded", "true");
        place(menu.panel);
        (menu.items.find(item => item.value === menu.select.value) || menu.items[0]).button.focus();
      };
      function render() {
        for (const menu of menus) {
          const selected = menu.select.options[menu.select.selectedIndex];
          const resolvedTheme = document.documentElement.dataset.theme || (media.matches ? "dark" : "light");
          menu.trigger.replaceChildren(icon(menu.kind === "language" ? "translate" : resolvedTheme === "dark" ? "moon" : "sun"));
          const label = `${IdySite.t(menu.kind)}: ${selected?.textContent || ""}`;
          menu.trigger.setAttribute("aria-label", label);
          menu.trigger.title = label;
          for (const item of menu.items) {
            item.label.textContent = item.option.textContent;
            item.button.setAttribute("aria-checked", String(menu.select.value === item.value));
          }
        }
      }
      for (const [index, kind] of ["theme", "language"].entries()) {
        const select = selects[index];
        const root = document.createElement("div");
        root.className = "preference-control";
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "icon-button";
        trigger.dataset.preference = kind;
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        const panel = document.createElement("div");
        panel.className = "preference-panel";
        panel.hidden = true;
        panel.id = `idy-${kind}-menu`;
        trigger.id = `idy-${kind}-trigger`;
        trigger.setAttribute("aria-controls", panel.id);
        panel.setAttribute("role", "menu");
        panel.setAttribute("aria-labelledby", trigger.id);
        const menu = { root, trigger, panel, select, kind, items: [] };
        for (const option of select.options) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "preference-option";
          button.setAttribute("role", "menuitemradio");
          button.tabIndex = -1;
          button.dataset.value = option.value;
          if (kind === "theme") button.append(icon(option.value === "system" ? "desktop" : option.value === "dark" ? "moon" : "sun"));
          const label = document.createElement("span");
          label.className = "option-label";
          const check = icon("check");
          check.classList.add("option-check");
          button.append(label, check);
          button.addEventListener("click", () => {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            render();
            close(true);
          });
          menu.items.push({ button, label, option, value: option.value });
          panel.append(button);
        }
        trigger.addEventListener("click", () => opened === menu ? close(false) : open(menu));
        trigger.addEventListener("keydown", event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            open(menu);
            if (event.key === "ArrowUp") menu.items.at(-1).button.focus();
          }
        });
        panel.addEventListener("keydown", event => {
          const index = menu.items.findIndex(item => item.button === document.activeElement);
          const last = menu.items.length - 1;
          let next;
          if (event.key === "ArrowDown") next = (index + 1) % menu.items.length;
          if (event.key === "ArrowUp") next = (index + last) % menu.items.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = last;
          if (next !== undefined) { event.preventDefault(); menu.items[next].button.focus(); }
          else if (event.key === "Tab") close(true);
        });
        root.addEventListener("focusout", event => {
          if (opened === menu && !root.contains(event.relatedTarget)) close(false);
        });
        select.addEventListener("change", render);
        root.append(trigger, panel);
        controls.append(root);
        menus.push(menu);
      }
      native.after(controls);
      native.hidden = true;
      document.addEventListener("idy:languagechange", render);
      media.addEventListener("change", render);
      window.addEventListener("storage", render);
      document.addEventListener("pointerdown", event => {
        if (opened && !opened.root.contains(event.target)) close(false);
        if (mobile?.open && !mobile.contains(event.target)) mobile.open = false;
      });
      document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        if (opened) { event.preventDefault(); close(true); }
        else if (mobile?.open) { event.preventDefault(); mobile.open = false; mobileSummary?.focus(); }
      });
      mobile?.addEventListener("toggle", () => { if (mobile.open) close(false); });
      mobile?.addEventListener("click", event => { if (event.target.closest("a")) mobile.open = false; });
      window.addEventListener("resize", () => { if (opened) place(opened.panel); });
      render();
    }
  });
})();
