"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThemeManager = void 0;
const vscode = __importStar(require("vscode"));
class ThemeManager {
    constructor() {
        this.currentTheme = vscode.window.activeColorTheme;
        this.themeColors = this.getThemeColors();
    }
    updateTheme(theme) {
        this.currentTheme = theme;
        this.themeColors = this.getThemeColors();
    }
    getThemeColors() {
        const isDark = this.currentTheme.kind === vscode.ColorThemeKind.Dark ||
            this.currentTheme.kind === vscode.ColorThemeKind.HighContrast;
        if (isDark) {
            return {
                background: '#1e1e1e',
                foreground: '#e0e0e0',
                buttonBackground: '#0e639c',
                buttonForeground: '#ffffff',
                buttonHoverBackground: '#1177bb',
                inputBackground: '#3c3c3c',
                inputBorder: '#555555',
                inputForeground: '#cccccc',
                errorForeground: '#f48771',
                sideBarBackground: '#252526',
                sideBarForeground: '#cccccc',
                accentColor: '#007acc'
            };
        }
        else {
            return {
                background: '#ffffff',
                foreground: '#333333',
                buttonBackground: '#0078d4',
                buttonForeground: '#ffffff',
                buttonHoverBackground: '#106ebe',
                inputBackground: '#ffffff',
                inputBorder: '#cccccc',
                inputForeground: '#333333',
                errorForeground: '#e81123',
                sideBarBackground: '#f3f3f3',
                sideBarForeground: '#333333',
                accentColor: '#0078d4'
            };
        }
    }
    getColors() {
        return this.themeColors;
    }
    getThemeKind() {
        return this.currentTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' :
            this.currentTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'hc';
    }
    getCSSVariables() {
        const colors = this.themeColors;
        return `
			:root {
				--vscode-background: ${colors.background};
				--vscode-foreground: ${colors.foreground};
				--vscode-button-background: ${colors.buttonBackground};
				--vscode-button-foreground: ${colors.buttonForeground};
				--vscode-button-hover-background: ${colors.buttonHoverBackground};
				--vscode-input-background: ${colors.inputBackground};
				--vscode-input-border: ${colors.inputBorder};
				--vscode-input-foreground: ${colors.inputForeground};
				--vscode-error-foreground: ${colors.errorForeground};
				--vscode-sidebar-background: ${colors.sideBarBackground};
				--vscode-sidebar-foreground: ${colors.sideBarForeground};
				--vscode-accent: ${colors.accentColor};
			}
		`;
    }
}
exports.ThemeManager = ThemeManager;
//# sourceMappingURL=themeManager.js.map