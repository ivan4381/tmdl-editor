# Prototype of plan §7.1 (container stack + fence) to validate against a real full-model script.
import re,sys,collections
NAME=r"('(?:[^']|'')+'|[^\s=:'.]+)"
CONTAINERS={'createorreplace','database','model'}
def depth(l): return len(l)-len(l.lstrip('\t'))
def parse(text):
    eol='\r\n' if '\r\n' in text else '\n'
    L=text.split(eol); objs=[]; stack=[]; fence=False
    for i,l in enumerate(L):
        s=l.rstrip()
        if fence:
            if s.strip()=='```': fence=False
            continue
        if not s.strip(): continue
        d=depth(l); body=s.strip(); low=body.lower()
        opens_fence=s.endswith('```') and '=' in s
        if body.startswith('///'):
            continue
        while stack and stack[-1][1]>=d: stack.pop()
        kw=low.split()[0]
        top=stack[-1] if stack else None
        all_cont=all(k in CONTAINERS for k,_,_ in stack)
        m=None
        if kw in CONTAINERS and all_cont:
            stack.append((kw,d,None))
        elif all_cont and (m:=re.match(r'^(ref\s+)?(table|expression|querygroup)\s+'+NAME+r'(\s*=.*)?$',body,re.I)):
            t=m.group(2).lower(); name=m.group(3)
            if name.startswith("'"): name=name[1:-1].replace("''","'")
            stack.append(('table' if t=='table' else t,d,name))
            if not m.group(1) and t=='table': objs.append((t,name,name,i))  # expression/queryGroup: dikenali, tidak editable
        elif top and top[0]=='table' and d==top[1]+1 and (m:=re.match(r'^(column|measure)\s+'+NAME+r'(\s*=.*)?$',body,re.I)):
            name=m.group(2)
            if name.startswith("'"): name=name[1:-1].replace("''","'")
            objs.append((m.group(1).lower(),top[2],name,i)); stack.append((m.group(1).lower(),d,name))
        else:
            stack.append(('other:'+kw,d,None))
        if opens_fence: fence=True
    # descriptions
    out=[]
    for t,tb,n,i in objs:
        j=i; ind=L[i][:depth(L[i])]
        while j>0 and L[j-1].startswith(ind+'///') and depth(L[j-1])==len(ind): j-=1
        out.append(dict(type=t,table=tb,name=n,decl=i,descStart=j,desc='\n'.join(x[len(ind)+3:].lstrip(' ') if x[len(ind)+3:4+len(ind)]==' ' else x[len(ind)+3:] for x in L[j:i])))
    return out,L,eol
if __name__=='__main__':
    o,L,eol=parse(open(sys.argv[1],encoding='utf-8',newline='').read())
    c=collections.Counter(x['type'] for x in o); print(dict(c))
    print('with desc',collections.Counter(x['type'] for x in o if x['desc']))
    print('without desc',[(x['type'],x['table'],x['name']) for x in o if not x['desc']])
    print('keys unique',len({(x['type'],x['table'],x['name']) for x in o})==len(o))
