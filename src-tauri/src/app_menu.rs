//! The ordinary macOS application menu, with the same roles and shortcuts as Tauri's default.
use tauri::{
    menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu},
    AppHandle, Wry,
};

use crate::language::{Locale, Text};

#[derive(Clone)]
pub struct AppMenu {
    items: Vec<(PredefinedMenuItem<Wry>, Text)>,
    submenus: Vec<(Submenu<Wry>, Text)>,
}

impl AppMenu {
    pub fn new(app: &AppHandle, locale: Locale) -> tauri::Result<Self> {
        let mut items = Vec::new();
        macro_rules! item {
            ($role:ident, $key:ident) => {{
                let item = PredefinedMenuItem::$role(app, Some(locale.text(Text::$key)))?;
                items.push((item.clone(), Text::$key));
                item
            }};
        }
        let about = PredefinedMenuItem::about(
            app,
            Some(locale.text(Text::About)),
            Some(AboutMetadata {
                name: Some("Nootify".into()),
                version: Some(app.package_info().version.to_string()),
                ..Default::default()
            }),
        )?;
        items.push((about.clone(), Text::About));
        let application = Submenu::with_items(
            app,
            "Nootify",
            true,
            &[
                &about,
                &PredefinedMenuItem::separator(app)?,
                &item!(services, Services),
                &PredefinedMenuItem::separator(app)?,
                &item!(hide, Hide),
                &item!(hide_others, HideOthers),
                &PredefinedMenuItem::separator(app)?,
                &item!(quit, Quit),
            ],
        )?;
        let file = Submenu::with_items(
            app,
            locale.text(Text::File),
            true,
            &[&item!(close_window, CloseWindow)],
        )?;
        let edit = Submenu::with_items(
            app,
            locale.text(Text::Edit),
            true,
            &[
                &item!(undo, Undo),
                &item!(redo, Redo),
                &PredefinedMenuItem::separator(app)?,
                &item!(cut, Cut),
                &item!(copy, Copy),
                &item!(paste, Paste),
                &item!(select_all, SelectAll),
            ],
        )?;
        let view = Submenu::with_items(
            app,
            locale.text(Text::View),
            true,
            &[&item!(fullscreen, Fullscreen)],
        )?;
        let window = Submenu::with_items(
            app,
            locale.text(Text::Window),
            true,
            &[
                &item!(minimize, Minimize),
                &item!(maximize, Zoom),
                &PredefinedMenuItem::separator(app)?,
                &item!(close_window, CloseWindow),
            ],
        )?;
        let help = Submenu::with_items(app, locale.text(Text::Help), true, &[])?;
        let menu = Menu::with_items(app, &[&application, &file, &edit, &view, &window, &help])?;
        app.set_menu(menu)?;
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
        Ok(Self {
            items,
            submenus: vec![
                (file, Text::File),
                (edit, Text::Edit),
                (view, Text::View),
                (window, Text::Window),
                (help, Text::Help),
            ],
        })
    }

    pub fn relocalize(&self, locale: Locale) {
        for (item, key) in &self.items {
            let _ = item.set_text(locale.text(*key));
        }
        for (menu, key) in &self.submenus {
            let _ = menu.set_text(locale.text(*key));
        }
    }
}
