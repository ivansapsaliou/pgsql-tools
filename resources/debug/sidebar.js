// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const state = { parameters: [], breakpoints: [], mode: 'trace', status: 'idle' };

	const el = {
		title: document.getElementById('sessionTitle'),
		meta: document.getElementById('sessionMeta'),
		status: document.getElementById('statusBadge'),
		params: document.getElementById('paramsContainer'),
		bpList: document.getElementById('bpList'),
		btnRun: document.getElementById('btnRun'),
		btnContinue: document.getElementById('btnContinue'),
		btnStop: document.getElementById('btnStop'),
		btnBpCurrent: document.getElementById('btnBpCurrent'),
		btnInfo: document.getElementById('btnInfo'),
	};

	function post(command, data) {
		vscode.postMessage({ command, ...data });
	}

	function renderStatus() {
		const labels = {
			idle: 'Готово',
			ready: 'Готово к запуску',
			running: 'Выполняется…',
			paused: 'Пауза',
			stopped: 'Остановлено',
			completed: 'Завершено',
			error: 'Ошибка',
		};
		el.status.textContent = labels[state.status] || state.status;
		el.status.className = 'status-badge ' + state.status;
		el.btnRun.disabled = state.status === 'running';
		el.btnContinue.disabled = state.status !== 'paused';
		el.btnStop.disabled = state.status !== 'running' && state.status !== 'paused';
	}

	function renderParams() {
		el.params.innerHTML = '';
		if (!state.parameters.length) {
			el.params.innerHTML = '<p class="empty-params">Нет входных параметров</p>';
			return;
		}
		for (const p of state.parameters) {
			const wrap = document.createElement('div');
			wrap.className = 'field';
			wrap.dataset.name = p.name;

			const label = document.createElement('label');
			label.innerHTML =
				`${escapeHtml(p.name)} <span class="type-hint">(${escapeHtml(p.mode)} · ${escapeHtml(p.dataType)})</span>`;

			let input;
			const k = p.widgetKind;
			const val = p.value ?? '';

			if (k === 'boolean') {
				wrap.classList.add('checkbox-row');
				input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = val === 'true' || val === 't' || val === '1';
				wrap.appendChild(input);
				wrap.appendChild(label);
			} else if (k === 'json' || k === 'array') {
				input = document.createElement('textarea');
				input.rows = k === 'array' ? 2 : 3;
				input.value = val;
				input.placeholder = k === 'array' ? '1, 2, 3  или  [1, 2, 3]' : '{}';
				wrap.appendChild(label);
				wrap.appendChild(input);
			} else if (k === 'date') {
				input = document.createElement('input');
				input.type = 'date';
				input.value = val;
				wrap.appendChild(label);
				wrap.appendChild(input);
			} else if (k === 'datetime') {
				input = document.createElement('input');
				input.type = 'datetime-local';
				input.value = val;
				wrap.appendChild(label);
				wrap.appendChild(input);
			} else if (k === 'time') {
				input = document.createElement('input');
				input.type = 'time';
				input.step = '1';
				input.value = val;
				wrap.appendChild(label);
				wrap.appendChild(input);
			} else if (k === 'number') {
				input = document.createElement('input');
				input.type = 'number';
				input.value = val;
				input.placeholder = '';
				wrap.appendChild(label);
				wrap.appendChild(input);
			} else {
				input = document.createElement('input');
				input.type = 'text';
				input.value = val;
				input.placeholder = '';
				wrap.appendChild(label);
				wrap.appendChild(input);
			}

			if (p.error) {
				wrap.classList.add('error');
				const err = document.createElement('span');
				err.className = 'field-error';
				err.textContent = p.error;
				wrap.appendChild(err);
			}

			const saveParam = () => {
				const v = readFieldValueFromWrap(wrap);
				p.value = v;
				post('paramChange', { name: p.name, value: v });
			};
			input?.addEventListener('change', saveParam);
			input?.addEventListener('input', () => {
				wrap.classList.remove('error');
				const errEl = wrap.querySelector('.field-error');
				if (errEl) errEl.remove();
				saveParam();
			});

			el.params.appendChild(wrap);
		}
	}

	function readFieldValue(p, input) {
		if (p.widgetKind === 'boolean') {
			return input.checked ? 'true' : 'false';
		}
		return input.value;
	}

	function readFieldValueFromWrap(wrap) {
		const name = wrap.dataset.name;
		const p = state.parameters.find((x) => x.name === name);
		if (!p) {
			return '';
		}
		const cb = wrap.querySelector('input[type="checkbox"]');
		if (cb) {
			return cb.checked ? 'true' : 'false';
		}
		const input = wrap.querySelector('input, textarea');
		return input ? readFieldValue(p, input) : '';
	}

	function syncParametersFromDom() {
		el.params.querySelectorAll('.field[data-name]').forEach((wrap) => {
			const name = wrap.dataset.name;
			const p = state.parameters.find((x) => x.name === name);
			if (p) {
				p.value = readFieldValueFromWrap(wrap);
			}
		});
	}

	function collectParamValues() {
		syncParametersFromDom();
		const out = {};
		for (const p of state.parameters) {
			out[p.name] = p.value ?? '';
		}
		return out;
	}

	function renderBreakpoints() {
		el.bpList.innerHTML = '';
		if (!state.breakpoints.length) {
			el.bpList.innerHTML = '<li class="help-text">Нет точек останова</li>';
			return;
		}
		for (const bp of state.breakpoints) {
			const li = document.createElement('li');
			li.className = 'bp-item';
			const line = document.createElement('span');
			line.className = 'bp-line';
			line.textContent = String(bp.line);
			line.title = 'Перейти к строке';
			line.addEventListener('click', () => post('goToLine', { line: bp.line }));
			const preview = document.createElement('span');
			preview.className = 'bp-preview';
			preview.textContent = bp.preview || '';
			preview.title = bp.preview || '';
			const rm = document.createElement('button');
			rm.className = 'bp-remove';
			rm.textContent = '×';
			rm.title = 'Удалить';
			rm.addEventListener('click', () => post('removeBreakpoint', { line: bp.line }));
			li.appendChild(line);
			li.appendChild(preview);
			li.appendChild(rm);
			el.bpList.appendChild(li);
		}
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	document.querySelectorAll('input[name="debugMode"]').forEach((radio) => {
		radio.addEventListener('change', () => {
			if (radio.checked) {
				state.mode = radio.value;
				post('setMode', { mode: state.mode });
			}
		});
	});

	el.btnRun?.addEventListener('click', () => post('run', { paramValues: collectParamValues() }));
	el.btnContinue?.addEventListener('click', () => post('continue', {}));
	el.btnStop?.addEventListener('click', () => post('stop', {}));
	el.btnBpCurrent?.addEventListener('click', () => post('toggleBreakpointCurrent', {}));
	el.btnInfo?.addEventListener('click', () => post('showHelp', {}));

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.command) {
			case 'init':
				state.parameters = msg.parameters || [];
				state.breakpoints = msg.breakpoints || [];
				state.mode = msg.mode || 'trace';
				state.status = msg.status || 'ready';
				if (el.title) el.title.textContent = msg.title || 'PL/pgSQL Debug';
				if (el.meta) el.meta.textContent = msg.meta || '';
				document.querySelectorAll('input[name="debugMode"]').forEach((r) => {
					r.checked = r.value === state.mode;
				});
				renderParams();
				renderBreakpoints();
				renderStatus();
				break;
			case 'setStatus':
				state.status = msg.status;
				renderStatus();
				break;
			case 'setBreakpoints':
				state.breakpoints = msg.breakpoints || [];
				renderBreakpoints();
				break;
			case 'setParamErrors':
				syncParametersFromDom();
				for (const e of msg.errors || []) {
					const p = state.parameters.find((x) => x.name === e.name);
					if (p) p.error = e.error;
				}
				renderParams();
				break;
			case 'clearParamErrors':
				state.parameters.forEach((p) => delete p.error);
				renderParams();
				break;
		}
	});

	post('ready', {});
})();
