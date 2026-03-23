import * as vscode from 'vscode';

export interface ThemeColors {
	background: string;
	foreground: string;
	buttonBackground: string;
	buttonForeground: string;
	buttonHoverBackground: string;
	inputBackground: string;
	inputBorder: string;
	inputForeground: string;
	errorForeground: string;
	sideBarBackground: string;
	sideBarForeground: string;
	accentColor: string;
}

export class ThemeManager {
	private currentTheme: vscode.ColorTheme;
	private themeColors: ThemeColors;

	constructor() {
		this.currentTheme = vscode.window.activeColorTheme;
		this.themeColors = this.getThemeColors();
	}

	updateTheme(theme: vscode.ColorTheme): void {
		this.currentTheme = theme;
		this.themeColors = this.getThemeColors();
	}

	private getThemeColors(): ThemeColors {
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
		} else {
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

	getColors(): ThemeColors {
		return this.themeColors;
	}

	getThemeKind(): string {
		return this.currentTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' :
			   this.currentTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'hc';
	}

	getCSSVariables(): string {
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