require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
require(['vs/editor/editor.main'],function(){
	let lastThemeDebug = null;

	function getComputedStyleValue(variable){
		try{
			return getComputedStyle(document.body).getPropertyValue(variable).trim();
		}catch(e){
			return '';
		}
	}

	function toMonacoHex(value, fallback){
		const v = String(value || '').trim();
		if(!v){ return fallback; }
		const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
		if(hex){
			const raw = hex[1];
			if(raw.length === 3){
				return raw.split('').map(function(ch){ return ch + ch; }).join('').toUpperCase();
			}
			return raw.toUpperCase();
		}
		const rgb = v.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if(rgb){
			const r = Math.max(0, Math.min(255, Number(rgb[1]) || 0));
			const g = Math.max(0, Math.min(255, Number(rgb[2]) || 0));
			const b = Math.max(0, Math.min(255, Number(rgb[3]) || 0));
			const toHex = function(n){ return n.toString(16).padStart(2,'0').toUpperCase(); };
			return toHex(r) + toHex(g) + toHex(b);
		}
		return fallback;
	}

	function tokenColor(vars, fallback){
		for(const cssVar of vars){
			const value = getComputedStyleValue(cssVar);
			if(value){
				const converted = toMonacoHex(value, '');
				if(converted){ return converted; }
			}
		}
		return fallback;
	}

	function collectVscodeCssVariables(){
		try{
			const computed = getComputedStyle(document.body);
			const vars = [];
			for(let i=0;i<computed.length;i++){
				const key = computed[i];
				if(!String(key).startsWith('--vscode-')){ continue; }
				const value = computed.getPropertyValue(key).trim();
				if(!value){ continue; }
				vars.push({ key, value });
			}
			vars.sort((a,b)=>a.key.localeCompare(b.key));
			return vars;
		}catch(e){
			return [];
		}
	}

	function toHexWithHash(raw){
		const normalized = toMonacoHex(raw, '');
		return normalized ? '#' + normalized : '';
	}

	function defineVscodeTheme(){
		const isDark = document.body.classList.contains('vscode-dark') ||
			document.body.classList.contains('vscode-high-contrast');
		const keywordColor = tokenColor(
			['--vscode-symbolIcon-functionForeground', '--vscode-editor-foreground'],
			isDark ? 'C586C0' : '0000FF'
		);
		const stringColor = tokenColor(
			['--vscode-debugTokenExpression-string', '--vscode-editor-foreground'],
			isDark ? 'CE9178' : 'A31515'
		);
		const numberColor = tokenColor(
			['--vscode-debugTokenExpression-number', '--vscode-editor-foreground'],
			isDark ? 'B5CEA8' : '098658'
		);
		const commentColor = tokenColor(
			['--vscode-editorLineNumber-foreground', '--vscode-descriptionForeground'],
			isDark ? '6A9955' : '008000'
		);
		const operatorColor = tokenColor(
			['--vscode-editor-foreground'],
			isDark ? 'D4D4D4' : '000000'
		);
		const typeColor = tokenColor(
			['--vscode-symbolIcon-classForeground', '--vscode-editor-foreground'],
			isDark ? '4EC9B0' : '267F99'
		);
		const functionColor = tokenColor(
			['--vscode-symbolIcon-functionForeground', '--vscode-editor-foreground'],
			isDark ? 'DCDCAA' : '795E26'
		);

		const vscodeTheme = {
			base: isDark ? 'vs-dark' : 'vs',
			inherit: true,
			rules: [
				// Основные
				{ token: 'keyword', foreground: keywordColor },
				
				// SQL-специфичные (могут отличаться!)
				{ token: 'keyword.sql', foreground: keywordColor },
				{ token: 'keyword.control.sql', foreground: keywordColor },
				{ token: 'keyword.ddl', foreground: keywordColor },
				{ token: 'keyword.dml', foreground: keywordColor },
				
				// Строки
				{ token: 'string', foreground: stringColor },
				{ token: 'string.sql', foreground: stringColor },
				
				// Комментарии
				{ token: 'comment', foreground: commentColor },
				{ token: 'comment.line', foreground: commentColor },
				
				// Числа
				{ token: 'number', foreground: numberColor },
				{ token: 'number.sql', foreground: numberColor },
				
				// Типы
				{ token: 'type', foreground: typeColor },
				{ token: 'type.identifier', foreground: typeColor },
				
				// Функции
				{ token: 'identifier.function', foreground: functionColor },
				{ token: 'entity.name.function', foreground: functionColor },
				
				// Операторы
				{ token: 'operator', foreground: operatorColor },
				{ token: 'delimiter', foreground: operatorColor },
			],
			colors: {
				'editor.background': getComputedStyleValue('--vscode-editor-background') || (isDark ? '#1e1e1e' : '#ffffff'),
				'editor.foreground': getComputedStyleValue('--vscode-editor-foreground') || (isDark ? '#d4d4d4' : '#000000'),
				'editor.lineHighlightBackground': getComputedStyleValue('--vscode-editorLineHighlightBackground') || (isDark ? '#264f78' : '#eeeeee'),
				'editor.selectionBackground': getComputedStyleValue('--vscode-editor.selectionBackground') || (isDark ? '#264f78' : '#add6ff'),
				'editorLineNumber.foreground': getComputedStyleValue('--vscode-editorLineNumber-foreground') || (isDark ? '#858585' : '#237893'),
				'editorCursor.foreground': getComputedStyleValue('--vscode-editorCursor-foreground') || (isDark ? '#aeafad' : '#000000'),
				'editor.inactiveSelectionBackground': getComputedStyleValue('--vscode-editor.inactiveSelectionBackground') || (isDark ? '#3a3d41' : '#e5ebf1'),
			},
		};

		if(document.body.classList.contains('vscode-high-contrast')){
			vscodeTheme.base = 'hc-black';
			vscodeTheme.colors['editor.background'] = getComputedStyleValue('--vscode-editor-background') || '#000000';
			vscodeTheme.colors['editor.foreground'] = getComputedStyleValue('--vscode-editor-foreground') || '#ffffff';
		}

		lastThemeDebug = {
			themeKind: document.body.classList.contains('vscode-high-contrast')
				? 'high-contrast'
				: (isDark ? 'dark' : 'light'),
			tokenColors: {
				keyword: '#' + keywordColor,
				string: '#' + stringColor,
				number: '#' + numberColor,
				comment: '#' + commentColor,
				operator: '#' + operatorColor,
				type: '#' + typeColor,
				function: '#' + functionColor,
			},
			cssRefs: {
				keyword: ['--vscode-symbolIcon-keywordForeground', '--vscode-editor-foreground'],
				string: ['--vscode-debugTokenExpression-string', '--vscode-editor-foreground'],
				number: ['--vscode-debugTokenExpression-number', '--vscode-editor-foreground'],
				comment: ['--vscode-editorLineNumber-foreground', '--vscode-descriptionForeground'],
				operator: ['--vscode-editor-foreground'],
				type: ['--vscode-symbolIcon-classForeground', '--vscode-editor-foreground'],
				function: ['--vscode-symbolIcon-functionForeground', '--vscode-editor-foreground'],
			},
			editorColors: vscodeTheme.colors,
			vscodeCssVariables: collectVscodeCssVariables(),
		};

		monaco.editor.defineTheme('vscode-theme', vscodeTheme);
		return 'vscode-theme';
	}

	const vscode = acquireVsCodeApi();

	function confirmModal(message, opts){
		const o = opts || {};
		const ov = document.getElementById('confirmOv');
		const titleEl = document.getElementById('confirmTitle');
		const msgEl = document.getElementById('confirmMsg');
		const okBtn = document.getElementById('confirmOk');
		const cancelBtn = document.getElementById('confirmCancel');
		const closeBtn = document.getElementById('confirmClose');

		titleEl.textContent = o.title || 'Confirm';
		msgEl.textContent = String(message || '');
		okBtn.textContent = o.okText || 'OK';
		cancelBtn.textContent = o.cancelText || 'Cancel';

		ov.style.display = 'flex';
		okBtn.focus();

		return new Promise((resolve)=>{
			function cleanup(){
				ov.style.display = 'none';
				document.removeEventListener('keydown', onKey);
				ov.removeEventListener('click', onOverlayClick);
				okBtn.removeEventListener('click', onOk);
				cancelBtn.removeEventListener('click', onCancel);
				closeBtn.removeEventListener('click', onCancel);
			}
			function finish(val){
				cleanup();
				resolve(!!val);
			}
			function onOk(){ finish(true); }
			function onCancel(){ finish(false); }
			function onOverlayClick(e){ if(e && e.target && e.target.id==='confirmOv'){ finish(false); } }
			function onKey(e){
				if(e.key==='Escape'){ finish(false); }
				if(e.key==='Enter'){ finish(true); }
			}
			okBtn.addEventListener('click', onOk);
			cancelBtn.addEventListener('click', onCancel);
			closeBtn.addEventListener('click', onCancel);
			ov.addEventListener('click', onOverlayClick);
			document.addEventListener('keydown', onKey);
		});
	}

	const editSaveBtn = document.getElementById('editSaveBtn');
	const themeDumpBtn = document.getElementById('themeDumpBtn');
	const dirtyState = document.getElementById('dirtyState');
	const editorHost = document.getElementById('ddlEditor');

	let ddlEditor = null;
	let lineDecorations = [];
	let isEditMode = false;
	const originalText = window.__PGTOOLS__?.ddl || '';
	const originalLines = originalText.split(/\r?\n/);

	const fontFamily = getComputedStyleValue('--vscode-editor-font-family') || 'Consolas, monospace';

	ddlEditor = monaco.editor.create(editorHost,{
		automaticLayout:true,
		minimap:{enabled:false},
		fontSize:13,
		fontFamily,
		wordWrap:'on',
		tabSize:2,
		lineNumbers:'on',
		glyphMargin:true,
		renderWhitespace:'none',
		scrollBeyondLastLine:false,
		value: originalText,
		language:'sql',
		theme: defineVscodeTheme(),
		quickSuggestions:{other:true,comments:false,strings:false},
		suggestOnTriggerCharacters:true,
		readOnly:true,
	});


	function getChangedLineNumbers(orig, cur){
		const n = orig.length;
		const m = cur.length;
		const dp = Array.from({length:n+1},()=>Array(m+1).fill(0));
		for(let i=n-1;i>=0;i--){
			for(let j=m-1;j>=0;j--){
				dp[i][j] = orig[i] === cur[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
			}
		}
		const unchangedCurLines = new Set();
		let i = 0;
		let j = 0;
		while(i<n && j<m){
			if(orig[i] === cur[j]){
				unchangedCurLines.add(j + 1);
				i++;
				j++;
				continue;
			}
			if(dp[i+1][j] >= dp[i][j+1]){ i++; }
			else{ j++; }
		}
		const changed = [];
		for(let line=1; line<=m; line++){
			if(!unchangedCurLines.has(line)){ changed.push(line); }
		}
		return changed;
	}

	function refreshChangedLineMarkers(){
		if(!ddlEditor){ return; }
		const model = ddlEditor.getModel();
		if(!model){ return; }
		const currentText = ddlEditor.getValue();
		if(currentText === originalText){
			lineDecorations = ddlEditor.deltaDecorations(lineDecorations, []);
			return;
		}
		const currentLines = model.getLinesContent();
		const changedLineNumbers = getChangedLineNumbers(originalLines, currentLines);
		const changedLines = [];
		for(const lineNo of changedLineNumbers){
			changedLines.push({
				range: new monaco.Range(lineNo,1,lineNo,1),
				options: { isWholeLine:false, linesDecorationsClassName:'line-modified-glyph' }
			});
		}
		lineDecorations = ddlEditor.deltaDecorations(lineDecorations, changedLines);
	}

	function refreshDirty(){
		if(!ddlEditor){ return; }
		const val = ddlEditor.getValue();
		const dirty = val !== originalText;
		refreshChangedLineMarkers();
		if(!isEditMode){
			dirtyState.textContent = dirty ? 'Modified' : 'Saved';
			editSaveBtn.textContent = '✎ Edit';
			editSaveBtn.disabled = false;
			return;
		}
		dirtyState.textContent = dirty ? 'Modified' : 'Saved';
		editSaveBtn.textContent = dirty ? '▶ Execute' : '▶ Execute (no changes)';
		editSaveBtn.disabled = !dirty;
	}

	ddlEditor.onDidChangeModelContent(()=>refreshDirty());
	refreshDirty();

	editSaveBtn.addEventListener('click', async ()=>{
		if(!ddlEditor){ return; }
		if(!isEditMode){
			isEditMode = true;
			ddlEditor.updateOptions({ readOnly: false });
			refreshDirty();
			return;
		}
		const ddlToExecute = ddlEditor.getValue();
		const ok = await confirmModal(
			'Execute DDL and recreate this routine?\n\nThe changes will apply immediately.',
			{ title:'Execute DDL', okText:'Execute', cancelText:'Cancel' }
		);
		if(!ok){ return; }
		editSaveBtn.disabled = true;
		vscode.postMessage({ command:'executeRoutineDDL', ddl: ddlToExecute });
	});

	function buildThemeDumpText(){
		const debug = lastThemeDebug || {};
		const lines = [];
		lines.push('Theme kind: ' + (debug.themeKind || 'unknown'));
		lines.push('');
		lines.push('[Monaco SQL token colors in use]');
		const tokenColors = debug.tokenColors || {};
		const tokenKeys = Object.keys(tokenColors);
		for(const key of tokenKeys){
			lines.push(key + ': ' + tokenColors[key]);
		}
		lines.push('');
		lines.push('[Token -> CSS variable chain]');
		const cssRefs = debug.cssRefs || {};
		const refKeys = Object.keys(cssRefs);
		for(const key of refKeys){
			lines.push(key + ': ' + cssRefs[key].join(' -> '));
		}
		lines.push('');
		lines.push('[Core editor colors]');
		const editorColors = debug.editorColors || {};
		const editorKeys = Object.keys(editorColors);
		for(const key of editorKeys){
			lines.push(key + ': ' + editorColors[key]);
		}
		lines.push('');
		lines.push('[All available --vscode-* CSS variables]');
		const vars = Array.isArray(debug.vscodeCssVariables) ? debug.vscodeCssVariables : [];
		for(const item of vars){
			const colorHex = toHexWithHash(item.value);
			lines.push(item.key + ': ' + item.value + (colorHex ? ' (' + colorHex + ')' : ''));
		}
		return lines.join('\n');
	}

	function openThemeDumpModal(){
		const ov = document.getElementById('themeOv');
		const closeBtn = document.getElementById('themeClose');
		const cancelBtn = document.getElementById('themeCancel');
		const copyBtn = document.getElementById('themeCopy');
		const content = document.getElementById('themeDumpContent');
		const copyState = document.getElementById('themeCopyState');
		if(!ov || !closeBtn || !cancelBtn || !copyBtn || !content){ return; }
		if(copyState){ copyState.textContent = ''; }
		content.textContent = buildThemeDumpText();
		ov.style.display = 'flex';

		function cleanup(){
			ov.style.display = 'none';
			document.removeEventListener('keydown', onKey);
			ov.removeEventListener('click', onOverlayClick);
			closeBtn.removeEventListener('click', onClose);
			cancelBtn.removeEventListener('click', onClose);
			copyBtn.removeEventListener('click', onCopy);
		}
		function onClose(){ cleanup(); }
		function onOverlayClick(e){ if(e && e.target && e.target.id === 'themeOv'){ cleanup(); } }
		function onKey(e){ if(e.key === 'Escape'){ cleanup(); } }
		async function onCopy(){
			try{
				await navigator.clipboard.writeText(content.textContent || '');
				if(copyState){ copyState.textContent = 'Copied'; }
			}catch(err){
				if(copyState){ copyState.textContent = 'Copy failed'; }
			}
		}

		closeBtn.addEventListener('click', onClose);
		cancelBtn.addEventListener('click', onClose);
		copyBtn.addEventListener('click', onCopy);
		ov.addEventListener('click', onOverlayClick);
		document.addEventListener('keydown', onKey);
	}

	if(themeDumpBtn){
		themeDumpBtn.addEventListener('click', function(){
			monaco.editor.setTheme(defineVscodeTheme());
			openThemeDumpModal();
		});
	}

	new MutationObserver(function(){
		monaco.editor.setTheme(defineVscodeTheme());
	}).observe(document.body,{attributes:true,attributeFilter:['class']});
	ddlEditor.layout();
	document.querySelectorAll('.tab').forEach(tab=>{
		tab.addEventListener('click',()=>{
			setTimeout(()=>ddlEditor && ddlEditor.layout(),30);
		});
	});
});
