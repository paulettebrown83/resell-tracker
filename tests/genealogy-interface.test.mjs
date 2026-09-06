import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
const rows=[{id:1,name:"O'Neil <img src=x onerror=alert(1)>",last_name:'Test',page_number:'4',type:'Death Story',date_of_article:'about 1913',brief_notes:'Original words',find_a_grave_url:'javascript:alert(1)',updated_at:'2026-09-01T00:00:00Z'}]
let saves=[],archives=[],failSave=false
const api={getRecords:async()=>rows,saveRecord:async(...args)=>{saves.push(args);if(failSave)throw new Error('Unconfirmed update')},archiveRecord:async(...args)=>archives.push(args)}
const dom=new JSDOM(await readFile(new URL('../public/genealogy-interface.html',import.meta.url),'utf8'),{url:'https://example.invalid/genealogy-interface.html',runScripts:'dangerously',beforeParse(win){Object.defineProperty(win,'parent',{value:{foundationGenealogy:api}});win.confirm=()=>true;win.scrollTo=()=>{}}})
const {window:w}=dom,d=w.document
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
try{
 await w.loadRecords()
 assert.equal(d.querySelector('#tableContainer img'),null)
 assert.equal(d.querySelector('#tableContainer a[href^="javascript:"]'),null)
 const archive=d.querySelector('button[title="Archive"]')
 assert.equal(archive.getAttribute('onclick'),'deleteRecord(1)')
 await w.editRecord(1)
 assert.equal(d.getElementById('date_of_article').value,'about 1913')
 assert.equal(d.getElementById('type').value,'Death Story')
 d.getElementById('brief_notes').value='Corrected words'
 failSave=true
 d.getElementById('snippetForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick()
 assert.equal(saves.length,1);assert.equal(saves[0][1].id,1)
 assert.equal(saves[0][0].type,'Death Story','Editing notes must preserve an existing type outside the default dropdown')
 assert.equal(d.getElementById('saveBtn').dataset.editId,'1')
 assert.equal(d.getElementById('brief_notes').value,'Corrected words')
 failSave=false
 d.getElementById('snippetForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick()
 assert.equal(saves.length,2);assert.equal(saves[1][1].id,1)
 assert.equal(d.getElementById('saveBtn').dataset.editId,undefined)
 await w.editRecord(1);w.clearForm()
 d.getElementById('name').value='New synthetic person'
 d.getElementById('snippetForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick()
 assert.equal(saves.length,3);assert.equal(saves[2].length,1)
 await w.deleteRecord(1)
 assert.deepEqual(archives,[[1,'2026-09-01T00:00:00Z']])
 console.log('PASS reused genealogy interface preserves text dates, prevents injected markup/links, retains failed edits, clears edit identity on cancel and archives without deletion')
}finally{w.close()}
