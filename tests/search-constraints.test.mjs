import test from 'node:test';
import assert from 'node:assert/strict';
import {searchConstraints,sourceConstraintFacts,constraintFit,constraintWeight,sourceHighlights,isDataTableSource} from '../src/search-constraints.mjs';

test('explicit framework and control constraints are bounded, negative clauses do not become requests',()=>{
 assert.deepEqual(searchConstraints('A Vue combobox, not a React table'),{frameworks:['Vue'],control:'combobox'});
 assert.deepEqual(searchConstraints('A solid table'),{frameworks:[],control:'table'});
 assert.deepEqual(searchConstraints('SolidJS table'),{frameworks:['Solid'],control:'table'});
 assert.equal(searchConstraints('Svelte date range picker').control,'date-range');
 assert.equal(searchConstraints('React resizable panels').control,'split-pane');
 assert.equal(searchConstraints('Angular file upload').control,'file-upload');
 assert.equal(searchConstraints('Preact tabs').control,'tabs');
 assert.deepEqual(searchConstraints('Web Components accessible tabs'),{frameworks:['Web Components'],control:'tabs'});
 assert.deepEqual(searchConstraints('https://example.org/vue/combobox'),{frameworks:[],control:null});
});

test('functional tables and grids do not include decorative/layout grids or document navigation',()=>{
 for(const value of ['Infinite Grid background','A bento grid layout','CSS grid with rows and columns','Read the table of contents','See Addon / Framework Support Table','Browser compatibility table','Framework comparison table'])assert.equal(isDataTableSource(value),false,value);
 for(const value of ['DataGrid','An accessible table','A grid with sorting and filtering','A paginated grid with row selection','Pricing comparison table'])assert.equal(isDataTableSource(value),true,value);
 assert.equal(searchConstraints('React grid background').control,null);
 assert.equal(searchConstraints('React grid with sorting and filtering').control,'table');
});

test('source constraints distinguish task from framework, ignore inference and preserve unknown as partial',()=>{
 const request=searchConstraints('Vue combobox with multiple selection');
 const fit=row=>constraintFit(request,sourceConstraintFacts(row));
 assert.deepEqual(fit({name:'Combobox',framework:'Vue'}),{framework:'declared',control:'source-mentioned'});
 assert.deepEqual(fit({name:'Combobox',description:'Inspired by Vue, React and Svelte',assessment:{capabilities:['Vue']}}),{framework:'unknown',control:'source-mentioned'});
 assert.deepEqual(fit({name:'ChartBarMultiple',framework:'Vue',description:'Select multiple series to compare'}),{framework:'declared',control:'unknown'});
 assert.equal(fit({name:'Combobox',framework:'React'}).framework,'different');
 assert.equal(fit({name:'Combobox',framework:'Vue / React'}).framework,'declared');
 assert.equal(fit({name:'Combobox',framework:'Web Components'}).framework,'unknown','Native elements are not a known conflicting renderer, but Vue integration is unproved');
 assert.equal(fit({name:'Combobox',framework:'React / Web Components'}).framework,'different','A specific renderer still supplies a differing framework fact');
 assert.ok(constraintWeight(fit({name:'Combobox',framework:'Vue'}))>constraintWeight(fit({name:'Combobox'})));
 assert.ok(constraintWeight(fit({name:'Combobox'}))>constraintWeight(fit({name:'Generic library',framework:'Vue'})));
 assert.ok(constraintWeight(fit({name:'Undocumented control'}))>0);
 assert.equal(constraintFit(request,sourceConstraintFacts({framework:'React'}),{component:false}).framework,'not-requested');
});

test('query-relevant source function evidence survives earlier setup sections without invented features',()=>{
 const row={name:'Backup server',description:'Backups',details:{features:['Install from a container image.'],sections:[{title:'Documentation',summary:'Clone the repository and read the guide.'},{title:'Backup destinations',summary:'Encrypted PostgreSQL backups can be stored in S3.'},{title:'Usage',summary:'Restore a previous database snapshot.'}],overview:'A database backup service.'},assessment:{capabilities:['private feature']}};
 const highlights=sourceHighlights('Encrypted PostgreSQL backups to S3',row);
 assert.ok(highlights.indexOf('Encrypted PostgreSQL backups')<highlights.indexOf('Clone the repository'));
 assert.ok(!highlights.includes('private feature'));
 const negative=sourceHighlights('Offline editing',{details:{features:['Offline editing is not supported.']}});assert.match(negative,/is not supported/);
});
