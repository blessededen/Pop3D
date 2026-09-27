import { describe, expect, it } from 'vitest';
import { demoProject, demoSpace, demoVendor } from './seed';
import { addFixtureIntent, removeFixtureIntent, replaceFixtureIntent } from './requirements';
import { chooseComposition } from './planner';
import { draftData } from './version';

describe('manual fixture planning intent',()=>{
  it('keeps a resized required counter in the next generated composition',()=>{
    const sp=demoSpace(),v=demoVendor(),p=demoProject(sp,v);
    const old=v.items.find(i=>i.sku===p.requirements.find(r=>r.category==='counter')!.sku)!;
    const item={...old,sku:'CUSTOM-COUNTER',w:.9,price:{...old.price,amount:null,status:'unknown' as const}};
    v.items.push(item); replaceFixtureIntent(p,old.sku,item,1);
    const result=chooseComposition(draftData(p,sp,v));
    expect(result.entries.find(e=>e.sku===item.sku)).toMatchObject({required:true,floor:1,qty:1,unit:null});
    expect(result.entries.some(e=>e.sku===old.sku)).toBe(false);
  });
  it('keeps three original hangers and one custom hanger rather than replacing every hanger',()=>{
    const sp=demoSpace(),v=demoVendor(),p=demoProject(sp,v);
    const old=v.items.find(i=>i.sku===p.requirements.find(r=>r.category==='hanger')!.sku)!;
    const item={...old,sku:'CUSTOM-HANGER',w:.8}; v.items.push(item);
    replaceFixtureIntent(p,old.sku,item,4);
    expect(p.requirements.find(r=>r.sku===old.sku)?.desiredQty).toBe(3);
    expect(p.requirements.find(r=>r.sku===item.sku)?.desiredQty).toBe(1);
  });
  it('preserves explicit additions in the next plan',()=>{
    const sp=demoSpace(),v=demoVendor(),p=demoProject(sp,v);
    const item=v.items.find(i=>i.category==='table')!;
    addFixtureIntent(p,item); addFixtureIntent(p,item);
    expect(p.requirements.find(r=>r.sku===item.sku)?.desiredQty).toBe(2);
    removeFixtureIntent(p,item.sku);
    expect(p.requirements.find(r=>r.sku===item.sku)?.desiredQty).toBe(1);
  });
  it('does not remove required minimum when user removes a placement',()=>{
    const v=demoVendor(),p=demoProject(demoSpace(),v),r=p.requirements.find(r=>r.category==='counter')!;
    removeFixtureIntent(p,r.sku);
    expect(p.requirements.find(x=>x.sku===r.sku)).toMatchObject({required:true,minQty:1,desiredQty:1});
  });
});
