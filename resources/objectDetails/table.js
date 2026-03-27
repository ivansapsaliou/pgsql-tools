require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
const vscode = acquireVsCodeApi();

function getVar(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function resolveMonacoBaseTheme(){
	if(document.body.classList.contains('vscode-high-contrast-light')){ return 'hc-light'; }
	if(document.body.classList.contains('vscode-high-contrast')){ return 'hc-black'; }
	if(document.body.classList.contains('vscode-dark')){ return 'vs-dark'; }
	return 'vs';
}
function applyTheme(){
	const base = resolveMonacoBaseTheme();
	const bg  = getVar('--vscode-editor-background');
	const fg  = getVar('--vscode-editor-foreground');
	const ln  = getVar('--vscode-editorLineNumber-foreground');
	const cur = getVar('--vscode-editorCursor-foreground');
	const sel = getVar('--vscode-editor-selectionBackground');
	const colors = Object.assign({},
		bg  ? {'editor.background': bg} : {},
		fg  ? {'editor.foreground': fg} : {},
		ln  ? {'editorLineNumber.foreground': ln} : {},
		cur ? {'editorCursor.foreground': cur} : {},
		sel ? {'editor.selectionBackground': sel} : {}
	);
	monaco.editor.defineTheme('vsc',{base,inherit:true,rules:[],colors});
	monaco.editor.setTheme('vsc');
}

let ddlEditor;
const config = window.__PGTOOLS__ || {};
require(['vs/editor/editor.main'],()=>{
	applyTheme();
	ddlEditor = monaco.editor.create(document.getElementById('ddlEditor'),{
		value: config.ddl || '',
		language:'sql',theme:'vsc',readOnly:true,
		minimap:{enabled:false},fontSize:13,
		fontFamily: getVar('--vscode-editor-font-family') || 'Consolas, monospace',
		automaticLayout:true,scrollBeyondLastLine:false,wordWrap:'on',
		tabSize:2,lineNumbers:'on',
	});
	new MutationObserver(applyTheme).observe(document.body,{attributes:true,attributeFilter:['class']});
});

let dataLoaded = false;
document.querySelectorAll('.tab').forEach(tab=>{
	tab.addEventListener('click',()=>{
		const name = tab.dataset.tab;
		document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(name+'-pane').classList.add('active');
		if(name==='ddl' && ddlEditor){ setTimeout(()=>ddlEditor.layout(),30); }
		if(name==='data' && !dataLoaded){ dataLoaded=true; loadPage(1); }
	});
});

document.addEventListener('click',e=>{
	const a=e.target.closest('.fk-link');
	if(a){ vscode.postMessage({command:'openTable',schema:a.dataset.schema,table:a.dataset.table}); }
});

document.getElementById('colSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#colBody tr').forEach(r=>{
		r.style.display=q&&!r.textContent.toLowerCase().includes(q)?'none':'';
	});
});

let selCol = null;
let selColMeta = null;
let modalMode = 'add';
let editOriginalColumnName = null;
let pendingDeleteColumn = null;

document.getElementById('colBody').addEventListener('click',function(e){
	const row = e.target instanceof Element ? e.target.closest('tr[data-col-name]') : null;
	if(!row){ return; }
	document.querySelectorAll('#colBody tr').forEach(r=>r.classList.remove('sel'));
	row.classList.add('sel');

	function decodeAttr(v){
		if(v===null||v===undefined){return null;}
		const ta=document.createElement('textarea');
		ta.innerHTML=String(v);
		return ta.value;
	}

	selCol = decodeAttr(row.getAttribute('data-col-name'));
	const defVal = decodeAttr(row.getAttribute('data-col-default'));
	const commentVal = decodeAttr(row.getAttribute('data-col-comment'));
	selColMeta = {
		colType: decodeAttr(row.getAttribute('data-col-type'))||'',
		notNull: row.getAttribute('data-col-notnull')==='1',
		defaultValue: defVal||null,
		comment: commentVal||null,
	};
	document.getElementById('deleteColBtn').disabled=false;
	document.getElementById('editColBtn').disabled=false;
});

document.getElementById('deleteColBtn').addEventListener('click', async function(){
	if(!selCol){ return; }
	const ok = await confirmModal(
		'Delete column "'+selCol+'"?\n\nAll data in this column will be permanently lost. Dependent objects will also be dropped (CASCADE).',
		{ title:'Delete column', okText:'Delete', cancelText:'Cancel' }
	);
	if(ok){
		pendingDeleteColumn = selCol;
		this.disabled = true;
		document.getElementById('editColBtn').disabled=true;
		vscode.postMessage({command:'deleteColumnClicked', columnName: selCol});
	}
});

document.getElementById('editColBtn').addEventListener('click',function(){
	if(!selCol||!selColMeta){return;}
	modalMode='edit';
	editOriginalColumnName=selCol;
	document.getElementById('modalTitle').textContent='Edit Column';
	document.getElementById('confirmModal').textContent='Save Changes';
	document.getElementById('addModal').style.display='flex';
	document.getElementById('nc-name').value=selCol;
	const typeSelect=document.getElementById('nc-type');
	const colType=selColMeta.colType||'';
	let hasOpt=false;
	for(const opt of typeSelect.options){if(opt.value===colType){hasOpt=true;break;}}
	if(!hasOpt){const opt=document.createElement('option');opt.value=colType;opt.textContent=colType;typeSelect.appendChild(opt);}
	typeSelect.value=colType;
	document.getElementById('nc-notnull').checked=!!selColMeta.notNull;
	document.getElementById('nc-default').value=selColMeta.defaultValue??'';
	document.getElementById('nc-comment').value=selColMeta.comment??'';
	document.getElementById('nc-name').focus();
});

document.getElementById('addColBtn').onclick=()=>{
	modalMode='add'; editOriginalColumnName=null;
	document.getElementById('modalTitle').textContent='Add Column';
	document.getElementById('confirmModal').textContent='Add Column';
	document.getElementById('addModal').style.display='flex';
	document.getElementById('nc-name').value='';
	document.getElementById('nc-default').value='';
	document.getElementById('nc-comment').value='';
	document.getElementById('nc-notnull').checked=false;
	const ts=document.getElementById('nc-type');
	if(ts&&ts.options.length){ts.value=ts.options[0].value;}
	document.getElementById('nc-name').focus();
};
function closeModal(){
	document.getElementById('addModal').style.display='none';
	modalMode='add'; editOriginalColumnName=null;
}
document.getElementById('closeModal').onclick=closeModal;
document.getElementById('cancelModal').onclick=closeModal;
document.getElementById('addModal').addEventListener('click',e=>{if(e.target.id==='addModal')closeModal();});
document.getElementById('confirmModal').onclick=()=>{
	const name=document.getElementById('nc-name').value.trim();
	if(!name){alert('Please enter a column name.');return;}
	if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)){alert('Invalid identifier.');return;}
	const columnType=document.getElementById('nc-type').value;
	const defaultValue=document.getElementById('nc-default').value.trim()||null;
	const comment=document.getElementById('nc-comment').value.trim()||null;
	if(modalMode==='add'){
		vscode.postMessage({command:'createColumn',columnName:name,columnType,
			notNull:document.getElementById('nc-notnull').checked,defaultValue,comment});
	}else{
		if(!editOriginalColumnName){alert('Column to edit is not selected.');return;}
		vscode.postMessage({command:'editColumn',originalColumnName:editOriginalColumnName,
			columnName:name,columnType,notNull:document.getElementById('nc-notnull').checked,defaultValue,comment});
	}
	closeModal();
};

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
		function finish(val){ cleanup(); resolve(!!val); }
		function onOk(){ finish(true); }
		function onCancel(){ finish(false); }
		function onOverlayClick(e){ if(e && e.target && e.target.id==='confirmOv'){ finish(false); } }
		function onKey(e){ if(e.key==='Escape'){ finish(false); } if(e.key==='Enter'){ finish(true); } }
		okBtn.addEventListener('click', onOk);
		cancelBtn.addEventListener('click', onCancel);
		closeBtn.addEventListener('click', onCancel);
		ov.addEventListener('click', onOverlayClick);
		document.addEventListener('keydown', onKey);
	});
}

const PK_COL = config.pkCol || '';
const ROW_CTID_COL = '__pgtools_ctid';
const ALL_COLUMNS = Array.isArray(config.allColumns) ? config.allColumns : [];
let PAGE_SIZE=1000, CUR=1, TOTAL_PAGES=1, HAS_MORE=false;
let SORT_COL=null, SORT_DIR='ASC', SORT_IDX=null, FIELDS=[];
const pendingEdits = new Map();
let originalData = [];
let serverRowsLen = 0;
const newRowIndices = new Set();
const selectedRowIndices = new Set();
let lastSelectedRowIndex = null;

function getEditCount(){ let n=0; for(const row of pendingEdits.values()) n+=row.size; return n; }
function updateChangesUI(){
	const n=getEditCount();
	const grp=document.getElementById('changesGroup');
	grp.style.display=n>0?'inline-flex':'none';
	document.getElementById('changesBadge').textContent=String(n);
}
function updateDeleteRowsButton(){ const btn = document.getElementById('deleteRowsBtn'); if (btn) { btn.disabled = selectedRowIndices.size === 0; } }
function setRowInfo(text){ const el = document.getElementById('rowInfo'); if(el){ el.textContent = text; } }
function applyRowSelectionStyles(){
	document.querySelectorAll('#dataBody tr[data-row]').forEach((tr)=>{
		const rowIdx = parseInt(tr.getAttribute('data-row')||'-1',10);
		tr.classList.toggle('selected', selectedRowIndices.has(rowIdx));
	});
	updateDeleteRowsButton();
}
function isNewRow(rowIdx){ return newRowIndices.has(rowIdx); }

function renderDataRows(){
	const tbody = document.getElementById('dataBody');
	const fields = FIELDS || [];
	if(!tbody){ return; }
	if(!originalData.length){
		tbody.innerHTML='<tr><td colspan="100%" style="text-align:center;opacity:.4;padding:20px;font-style:italic">No data</td></tr>';
		return;
	}
	tbody.innerHTML=originalData.map((row,ri)=>{
		const cells=fields.map(f=>{
			const v=row[f];
			const isNull=v===null || v===undefined;
			const newRow=isNewRow(ri);
			const isPk=f===PK_COL;
			const disp = isNull ? (newRow ? '' : 'NULL') : escH(String(v));
			const dispClass = (isNull && !newRow) ? 'cell-display null-val' : 'cell-display';
			return '<td class="cell'+(isPk?' pk-cell':'')+'" data-row="'+ri+'" data-col="'+escH(f)+'">'
				+'<span class="'+dispClass+'">'+disp+'</span>'
				+'<input class="cell-input" type="text" value="'+escH(isNull ? '' : String(v))+'">'
				+'</td>';
		}).join('');
		return '<tr data-row="'+ri+'"><td class="row-num">'+(ri+1+(CUR-1)*PAGE_SIZE)+'</td>'+cells+'</tr>';
	}).join('');
	applyRowSelectionStyles();
}

document.getElementById('applyChangesBtn').addEventListener('click',()=>{
	const updates=[];
	const insertValuesByRow = new Map();
	for(const rowIdx of Array.from(newRowIndices)){ insertValuesByRow.set(rowIdx, {}); }
	for(const [rowIdx, colMap] of pendingEdits.entries()){
		const orig=originalData[rowIdx];
		if(!orig){continue;}
		if(isNewRow(rowIdx)){
			const values = insertValuesByRow.get(rowIdx);
			if(!values){continue;}
			for(const [col,val] of colMap.entries()){
				let v = val;
				if(typeof v === 'string' && v.trim().toUpperCase()==='NULL'){ v = null; }
				values[col]=v;
			}
		}else{
			const pkVal=orig[PK_COL];
			const rowCtid=orig[ROW_CTID_COL]||null;
			for(const [col,val] of colMap.entries()){ updates.push({pkCol:PK_COL, pkVal, rowCtid, col, val}); }
		}
	}
	const inserts = Array.from(insertValuesByRow.entries()).map(([_, values])=>({ values }));
	if(updates.length===0 && inserts.length===0){return;}
	setRowInfo('Sending: applyTableRowEdits (inserts: ' + inserts.length + ', updates: ' + updates.length + ')...');
	document.getElementById('applyChangesBtn').disabled=true;
	vscode.postMessage({command:'applyTableRowEdits', updates, inserts});
});

document.getElementById('discardChangesBtn').addEventListener('click',()=>{
	pendingEdits.clear(); newRowIndices.clear(); selectedRowIndices.clear(); lastSelectedRowIndex = null;
	originalData = originalData.slice(0, serverRowsLen); updateChangesUI(); document.getElementById('applyChangesBtn').disabled=false; renderDataRows();
});

document.getElementById('dataBody').addEventListener('dblclick',e=>{
	const cell=e.target.closest('td.cell'); if(!cell){return;}
	if(cell.dataset.col===PK_COL && PK_COL!==''){ return; }
	startCellEdit(cell);
});

function startCellEdit(cell){
	if(cell.classList.contains('editing')){return;}
	cell.classList.add('editing');
	const input=cell.querySelector('input.cell-input');
	const disp=cell.querySelector('.cell-display');
	const rowIdx=parseInt(cell.dataset.row);
	const col=cell.dataset.col;
	const orig=originalData[rowIdx];
	const currentVal=(pendingEdits.get(rowIdx)?.get(col)!==undefined) ? pendingEdits.get(rowIdx).get(col) : (orig?(orig[col]===undefined?null:orig[col]):null);
	input.value=(currentVal===null)?'':String(currentVal); input.focus(); input.select();
	function commit(){
		cell.classList.remove('editing');
		const newVal=input.value;
		const origVal=orig?(orig[col]===undefined?null:orig[col]):null;
		const origStr=(origVal===null)?'':String(origVal);
		if(newVal!==origStr){
			if(!pendingEdits.has(rowIdx)){pendingEdits.set(rowIdx,new Map());}
			pendingEdits.get(rowIdx).set(col,newVal===''?null:newVal);
			const newRow=isNewRow(rowIdx);
			if(newVal==='' && newRow){ disp.textContent=''; disp.className='cell-display'; }
			else{ disp.textContent=newVal===''?'NULL':newVal; disp.className=newVal===''?'cell-display null-val':'cell-display'; }
			cell.classList.add('edited');
		} else {
			if(pendingEdits.has(rowIdx)){pendingEdits.get(rowIdx).delete(col);}
			const newRow=isNewRow(rowIdx);
			if(origVal===null && newRow){ disp.textContent=''; disp.className='cell-display'; }
			else{ disp.textContent=origVal===null?'NULL':String(origVal); disp.className=origVal===null?'cell-display null-val':'cell-display'; }
			cell.classList.remove('edited');
		}
		updateChangesUI();
	}
	input.addEventListener('blur',()=>commit(),{once:true});
	input.addEventListener('keydown',ev=>{
		if(ev.key==='Enter'){input.blur();}
		if(ev.key==='Escape'){ cell.classList.remove('editing'); input.removeEventListener('blur',commit); }
	});
}

document.getElementById('dataBody').addEventListener('click',e=>{
	const row=e.target.closest('tr[data-row]'); if(!row){return;}
	const rowIdx = parseInt(row.dataset.row,10); if(Number.isNaN(rowIdx)){return;}
	if(e.shiftKey && lastSelectedRowIndex!==null){
		const [from,to]=rowIdx>lastSelectedRowIndex?[lastSelectedRowIndex,rowIdx]:[rowIdx,lastSelectedRowIndex];
		selectedRowIndices.clear(); for(let i=from;i<=to;i++){selectedRowIndices.add(i);}
	}else if(e.ctrlKey || e.metaKey){
		if(selectedRowIndices.has(rowIdx)){selectedRowIndices.delete(rowIdx);} else{selectedRowIndices.add(rowIdx);}
		lastSelectedRowIndex=rowIdx;
	}else{
		selectedRowIndices.clear(); selectedRowIndices.add(rowIdx); lastSelectedRowIndex=rowIdx;
	}
	applyRowSelectionStyles();
});

document.getElementById('deleteRowsBtn').addEventListener('click', async ()=>{
	vscode.postMessage({ command:'__deleteRowsButtonClicked' });
	setRowInfo('Preparing delete... (selected: ' + selectedRowIndices.size + ')');
	if(selectedRowIndices.size===0){ return; }
	const sorted = Array.from(selectedRowIndices).sort((a,b)=>a-b);
	const newSelected = sorted.filter((idx)=>isNewRow(idx));
	const persistedSelected = sorted.filter((idx)=>!isNewRow(idx));
	setRowInfo('Delete: selected=' + sorted.length + ', new=' + newSelected.length + ', persisted=' + persistedSelected.length);
	if(newSelected.length>0){
		pendingEdits.clear(); newRowIndices.clear(); selectedRowIndices.clear(); lastSelectedRowIndex = null;
		if(typeof serverRowsLen === 'number' && serverRowsLen>=0){ originalData = originalData.slice(0, serverRowsLen); }
		updateChangesUI(); renderDataRows();
	}
	if(persistedSelected.length===0){ return; }
	const ok = await confirmModal(
		'Delete '+persistedSelected.length+' selected row(s) from server?\n\nThis action cannot be undone.',
		{ title:'Delete rows', okText:'Delete', cancelText:'Cancel' }
	);
	if(!ok){return;}
	const rows = persistedSelected.map((idx)=>{
		const data = originalData[idx] || {};
		return { pkCol: PK_COL, pkVal: Object.prototype.hasOwnProperty.call(data, PK_COL) ? data[PK_COL] : null, rowCtid: data[ROW_CTID_COL] || null };
	});
	setRowInfo('Sending: deleteRows (' + rows.length + ' persisted row(s))...');
	vscode.postMessage({ command:'deleteRows', rows });
});

function addEmptyLocalRow(){
	const newIdx = originalData.length;
	const row = {};
	for(const col of ALL_COLUMNS){ row[col] = null; }
	row[ROW_CTID_COL] = null;
	originalData.push(row); newRowIndices.add(newIdx);
	selectedRowIndices.clear(); selectedRowIndices.add(newIdx); lastSelectedRowIndex = newIdx;
	renderDataRows();
	const tr = document.querySelector('#dataBody tr[data-row="'+newIdx+'"]');
	if(tr){ tr.scrollIntoView({ block:'nearest' }); }
}
document.getElementById('addRowBtn').addEventListener('click', addEmptyLocalRow);

document.getElementById('dataSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#dataBody tr').forEach(r=>{ r.style.display=q&&!r.innerText.toLowerCase().includes(q)?'none':''; });
});
function pageRange(c,t){ if(t<=7)return Array.from({length:t},(_,i)=>i+1); if(c<=4)return[1,2,3,4,5,'…',t]; if(c>=t-3)return[1,'…',t-4,t-3,t-2,t-1,t]; return[1,'…',c-1,c,c+1,'…',t]; }
function renderPag(){
	const box=document.getElementById('pageButtons'); box.innerHTML='';
	pageRange(CUR,TOTAL_PAGES).forEach(p=>{
		if(p==='…'){const s=document.createElement('span');s.textContent='…';s.style.cssText='padding:0 4px;opacity:.4;font-size:11px';box.appendChild(s);}
		else{const b=document.createElement('button');b.className='pbtn'+(p===CUR?' active':'');b.textContent=p;b.onclick=()=>loadPage(p);box.appendChild(b);}
	});
	document.getElementById('pagInfo').textContent='Page '+CUR+' of '+TOTAL_PAGES;
	document.getElementById('prevPage').disabled=CUR===1;
	document.getElementById('nextPage').disabled=CUR>=TOTAL_PAGES&&!HAS_MORE;
}
function loadPage(p){
	CUR=p; renderPag(); document.getElementById('rowInfo').textContent='Loading...';
	pendingEdits.clear(); selectedRowIndices.clear(); lastSelectedRowIndex = null; newRowIndices.clear(); applyRowSelectionStyles(); updateChangesUI();
	PAGE_SIZE=parseInt(document.getElementById('dataLimit').value,10)||1000;
	if(SORT_COL&&FIELDS.includes(SORT_COL)){ vscode.postMessage({command:'loadSortedPage',page:p,limit:PAGE_SIZE,orderBy:SORT_COL,orderDir:SORT_DIR}); }
	else{ vscode.postMessage({command:'loadPage',page:p,limit:PAGE_SIZE}); }
}
document.getElementById('dataLimit').addEventListener('change',()=>{PAGE_SIZE=parseInt(document.getElementById('dataLimit').value,10)||1000;loadPage(1);});
document.getElementById('prevPage').onclick=()=>{if(CUR>1)loadPage(CUR-1);};
document.getElementById('nextPage').onclick=()=>{if(CUR<TOTAL_PAGES||HAS_MORE)loadPage(CUR+1);};
document.addEventListener('click',e=>{
	const th=e.target.closest('#dataTable th.sortable');
	if(!th){return;}
	const idx=parseInt(th.dataset.col,10);
	const colName=th.dataset.colname||'';
	if(SORT_IDX===idx){SORT_DIR=SORT_DIR==='ASC'?'DESC':'ASC';} else{SORT_IDX=idx;SORT_DIR='ASC';}
	SORT_COL=colName;
	document.querySelectorAll('#dataTable th.sortable').forEach(h=>h.classList.remove('sorted-asc','sorted-desc'));
	th.classList.add(SORT_DIR==='ASC'?'sorted-asc':'sorted-desc');
	loadPage(1);
});

window.addEventListener('message',e=>{
	const msg=e.data;
	if(msg.command==='pageData'){
		const tbody=document.getElementById('dataBody');
		const fields=msg.fields||[];
		if(fields.length>0){FIELDS=fields;}
		originalData=msg.rows||[]; serverRowsLen = originalData.length; newRowIndices.clear();
		if(!originalData.length){
			tbody.innerHTML='<tr><td colspan="100%" style="text-align:center;opacity:.4;padding:20px;font-style:italic">No data</td></tr>';
			document.getElementById('rowInfo').textContent='0 rows'; document.getElementById('dataPag').style.display='none'; return;
		}
		selectedRowIndices.clear(); lastSelectedRowIndex = null; renderDataRows();
		HAS_MORE=originalData.length>=PAGE_SIZE; TOTAL_PAGES=HAS_MORE?CUR+1:CUR;
		const s=(CUR-1)*PAGE_SIZE+1, en=(CUR-1)*PAGE_SIZE+originalData.length;
		document.getElementById('rowInfo').textContent=s+'-'+en+(HAS_MORE?'+ rows':' rows');
		const pag=document.getElementById('dataPag'); pag.style.display=(TOTAL_PAGES>1||HAS_MORE)?'flex':'none'; renderPag();
		if(msg.orderBy){
			SORT_COL=msg.orderBy; SORT_DIR=msg.orderDir||'ASC'; SORT_IDX=FIELDS.indexOf(msg.orderBy);
			document.querySelectorAll('#dataTable th.sortable').forEach(h=>{
				h.classList.remove('sorted-asc','sorted-desc');
				if(parseInt(h.dataset.col)===SORT_IDX){h.classList.add(SORT_DIR==='ASC'?'sorted-asc':'sorted-desc');}
			});
		}
		return;
	}
	if(msg.command==='rowChangesApplied'){
		pendingEdits.forEach((colMap,rowIdx)=>{ if(!originalData[rowIdx]){return;} colMap.forEach((val,col)=>{originalData[rowIdx][col]=val;}); });
		pendingEdits.clear();
		document.querySelectorAll('#dataBody td.cell.edited').forEach(c=>c.classList.remove('edited'));
		updateChangesUI(); document.getElementById('applyChangesBtn').disabled=false; setRowInfo('✓ applyRowChanges applied');
	}
	if(msg.command==='rowChangesFailed'){ document.getElementById('applyChangesBtn').disabled=false; setRowInfo('✗ applyRowChanges failed'); }
	if(msg.command==='rowsDeleted'){ selectedRowIndices.clear(); lastSelectedRowIndex = null; applyRowSelectionStyles(); loadPage(CUR); setRowInfo('✓ deleteRows applied (' + (msg.deleted ?? 'ok') + ')'); return; }
	if(msg.command==='deleteRowsFailed'){ setRowInfo('✗ deleteRows failed (see console / Query Results)'); return; }
	if(msg.command==='tableRowEditsApplied'){ pendingEdits.clear(); newRowIndices.clear(); selectedRowIndices.clear(); lastSelectedRowIndex = null; document.getElementById('applyChangesBtn').disabled=false; loadPage(CUR); setRowInfo('✓ applyTableRowEdits applied'); return; }
	if(msg.command==='tableRowEditsFailed'){ document.getElementById('applyChangesBtn').disabled=false; setRowInfo('✗ applyTableRowEdits failed (see console / Query Results)'); return; }
	if(msg.command==='deleteColumnApplied'){ pendingDeleteColumn=null; return; }
	if(msg.command==='deleteColumnFailed'){
		const deleteBtn=document.getElementById('deleteColBtn');
		const editBtn=document.getElementById('editColBtn');
		if(deleteBtn){ deleteBtn.disabled = !selCol; }
		if(editBtn){ editBtn.disabled = !selCol; }
		const errText = msg.error || ('Failed to delete column "'+(pendingDeleteColumn||'')+'"');
		pendingDeleteColumn=null;
		alert(errText);
	}
});

function escH(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
