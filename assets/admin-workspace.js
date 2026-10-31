(function(){
  const $ = (id) => document.getElementById(id);
  function makePage(id,title,subtitle){
    const page=document.createElement('section');
    page.className='admin-page'+(id==='home'?' active':'');
    page.dataset.page=id;
    if(title){
      const heading=document.createElement('div');
      heading.className='admin-page-title';
      const copy=document.createElement('div');
      const h=document.createElement('h1');h.textContent=title;
      const p=document.createElement('p');p.textContent=subtitle||'Тихий ролл · панель владельца';
      copy.append(h,p);heading.append(copy);page.append(heading);
    }
    return page;
  }
  function init(){
    const wrap=document.querySelector('main.wrap');
    const app=$('app');
    if(!wrap||!app||wrap.dataset.premiumReady==='1')return;
    wrap.dataset.premiumReady='1';
    const head=wrap.querySelector('.head');
    const status=$('status');
    const foot=wrap.querySelector('.foot');
    const sitePanel=$('reloadContent')?.closest('.panel');
    const panels=[...app.children].filter(el=>el!==$('editor'));
    const productsPanel=panels[0];
    const ordersPanel=panels[1];
    const categoriesPanel=panels[2];
    const editor=$('editor');
    const shell=document.createElement('div');shell.className='admin-shell';
    const sidebar=document.createElement('aside');sidebar.className='admin-sidebar';
    sidebar.innerHTML='<div class="admin-logo"><span>Т</span> ТИХИЙ РОЛЛ<small>АДМИН-ПАНЕЛЬ</small></div><nav class="admin-nav" aria-label="Разделы админ-панели"></nav><div class="admin-sidebar-foot">Панель владельца<br>Данные загружаются с сервера</div>';
    const nav=sidebar.querySelector('.admin-nav');
    const main=document.createElement('div');main.className='admin-main';
    wrap.insertBefore(shell,head);
    shell.append(sidebar,main);
    main.append(head,status,app);
    if(foot)main.append(foot);
    const home=makePage('home','Главная админ-панели','Обзор магазина и быстрый доступ к ежедневным задачам');
    home.innerHTML += '<div class="admin-home-hero"><div><h2>Тихий ролл · панель владельца</h2><p>Управляй заказами, меню и оформлением магазина из одного места.</p></div><div class="admin-home-actions"><button class="btn primary" type="button" data-go="orders">Открыть заказы</button><button class="btn" type="button" data-go="products">Добавить товар</button></div></div><div class="admin-home-kpis"><div class="admin-home-kpi"><span>Товаров в меню</span><strong id="homeProductCount">—</strong></div><div class="admin-home-kpi"><span>Состояние доступа</span><strong id="homeAccess">Проверяется</strong></div><div class="admin-home-kpi"><span>Сводка заказов</span><strong id="homeOrders">Загружается</strong></div></div><div class="panel"><div class="toolbar"><div><h2 style="margin:0">Быстрые действия</h2><p class="muted">Открывай нужный раздел одним нажатием.</p></div></div><div class="admin-home-shortcuts"><button class="admin-home-shortcut" type="button" data-go="orders"><i>▤</i><span><b>Заказы</b><small>Проверить новые и обновить статусы</small></span></button><button class="admin-home-shortcut" type="button" data-go="products"><i>🍣</i><span><b>Товары</b><small>Цены, фотографии и состав</small></span></button><button class="admin-home-shortcut" type="button" data-go="store"><i>▧</i><span><b>Главная и баннеры</b><small>Слайды и готовые сеты</small></span></button></div></div>';
    const pageOrders=makePage('orders','Заказы','Новые заказы, приготовление и выдача');
    const pageProducts=makePage('products','Товары','Ассортимент, фотографии, состав и цены');
    const pageStore=makePage('store','Категории и оформление','Категории меню, готовые сеты и рекламные блоки');
    const pageAnalytics=makePage('analytics','Аналитика продаж','Реальные показатели заказов из базы магазина');
    const analyticsRoot=document.createElement('div');analyticsRoot.className='admin-analytics-root';pageAnalytics.append(analyticsRoot);
    if(productsPanel)pageProducts.append(productsPanel);
    if(editor)pageProducts.append(editor);
    if(ordersPanel)pageOrders.append(ordersPanel);
    if(categoriesPanel)pageStore.append(categoriesPanel);
    if(sitePanel){sitePanel.id='siteContentPanel';pageStore.append(sitePanel)}
    app.replaceChildren(home,pageOrders,pageProducts,pageStore,pageAnalytics);
    function renderAnalytics(){
      const report=window.__TIHIY_ADMIN_REPORT__;
      analyticsRoot.replaceChildren();
      if(!report||!report.summary){
        const empty=document.createElement('div');empty.className='panel';empty.textContent='Загрузка статистики…';analyticsRoot.append(empty);return;
      }
      const summary=report.summary;
      const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';
      const cards=[
        ['Выручка без отмен',money(summary.revenue),'Заказы без статуса «Отменён»'],
        ['Всего заказов',String(summary.orders_count||0),'За всю сохранённую историю'],
        ['Валовая прибыль',money(summary.gross_profit),'По позициям с заполненной себестоимостью'],
        ['В работе',String(summary.active_orders||0),'Не завершены и не отменены']
      ];
      const grid=document.createElement('div');grid.className='admin-home-kpis admin-analytics-kpis';
      cards.forEach(([label,value,note])=>{
        const card=document.createElement('article');card.className='admin-home-kpi';
        const l=document.createElement('span');l.textContent=label;
        const v=document.createElement('strong');v.textContent=value;
        const n=document.createElement('small');n.textContent=note;n.className='admin-analytics-note';
        card.append(l,v,n);grid.append(card);
      });
      analyticsRoot.append(grid);
      const chartPanel=document.createElement('section');chartPanel.className='panel admin-analytics-panel';
      const chartTitle=document.createElement('h2');chartTitle.textContent='Выручка за последние 7 дней';chartPanel.append(chartTitle);
      const trend=Array.isArray(report.trend)?report.trend:[];
      const bars=document.createElement('div');bars.className='admin-analytics-bars';
      const max=Math.max(1,...trend.map(row=>Number(row.revenue)||0));
      trend.forEach(row=>{
        const column=document.createElement('div');column.className='admin-analytics-column';
        const amount=document.createElement('span');amount.className='admin-analytics-amount';amount.textContent=money(row.revenue||0);
        const track=document.createElement('div');track.className='admin-analytics-track';
        const bar=document.createElement('span');bar.className='admin-analytics-bar';bar.style.height=Math.max(3,((Number(row.revenue)||0)/max)*100)+'%';track.append(bar);
        const label=document.createElement('small');label.textContent=row.label||'';
        const count=document.createElement('em');count.textContent=(row.orders||0)+' зак.';
        column.append(amount,track,label,count);bars.append(column);
      });
      chartPanel.append(bars);
      const chartNote=document.createElement('p');chartNote.className='muted';chartNote.textContent='Дневной график рассчитан по последним '+(report.recentOrdersCount||0)+' загруженным заказам. Сводные показатели выше учитывают всю историю.';chartPanel.append(chartNote);
      analyticsRoot.append(chartPanel);
      const lower=document.createElement('div');lower.className='admin-analytics-lower';
      const statusPanel=document.createElement('section');statusPanel.className='panel';
      const statusTitle=document.createElement('h2');statusTitle.textContent='Статусы заказов';statusPanel.append(statusTitle);
      const statusNames={new:'Новые',accepted:'Приняты',preparing:'Готовятся',ready:'Готовы',completed:'Выданы',cancelled:'Отменены'};
      const statusColors={new:'#3898ff',accepted:'#e9a13a',preparing:'#ff5148',ready:'#3cbf89',completed:'#697780',cancelled:'#a56b80'};
      Object.entries(statusNames).forEach(([key,label])=>{
        const row=document.createElement('div');row.className='admin-status-row';
        const dot=document.createElement('i');dot.style.background=statusColors[key];
        const name=document.createElement('span');name.textContent=label;
        const value=document.createElement('b');value.textContent=String((report.statusCounts||{})[key]||0);
        row.append(dot,name,value);statusPanel.append(row);
      });
      const statusNote=document.createElement('p');statusNote.className='muted';statusNote.textContent='Распределение статусов показано по последним загруженным заказам.';statusPanel.append(statusNote);
      const popularPanel=document.createElement('section');popularPanel.className='panel';
      const popularTitle=document.createElement('h2');popularTitle.textContent='Популярные позиции';popularPanel.append(popularTitle);
      const popular=Array.isArray(summary.popular_items)?summary.popular_items:[];
      if(!popular.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Пока недостаточно данных о продажах.';popularPanel.append(empty)}
      popular.slice(0,8).forEach((item,index)=>{
        const row=document.createElement('div');row.className='admin-popular-row';
        const rank=document.createElement('span');rank.className='admin-popular-rank';rank.textContent=String(index+1);
        const name=document.createElement('b');name.textContent=item.name||'Позиция';
        const qty=document.createElement('span');qty.textContent=(item.qty||0)+' шт.';
        row.append(rank,name,qty);popularPanel.append(row);
      });
      lower.append(statusPanel,popularPanel);analyticsRoot.append(lower);
    }
    window.addEventListener('tihiy:analytics-updated',renderAnalytics);
    renderAnalytics();
    const navItems=[
      ['home','⌂','Главная'],
      ['orders','▤','Заказы'],
      ['products','▦','Товары'],
      ['store','✦','Категории и баннеры'],
      ['analytics','▥','Аналитика']
    ];
    function activate(id){
      app.querySelectorAll('.admin-page').forEach(p=>p.classList.toggle('active',p.dataset.page===id));
      nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.go===id));
      try{sessionStorage.setItem('tihiy-admin-page',id)}catch(_){}
      window.scrollTo({top:0,behavior:'smooth'});
    }
    navItems.forEach(([id,icon,label])=>{
      const b=document.createElement('button');b.type='button';b.dataset.go=id;
      const i=document.createElement('span');i.className='nav-icon';i.textContent=icon;
      const t=document.createElement('span');t.textContent=label;b.append(i,t);
      b.addEventListener('click',()=>activate(id));nav.append(b);
    });
    sidebar.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>activate(b.dataset.go)));
    home.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>{
      const id=b.dataset.go;activate(id);
      if(id==='products'&&$('add'))$('add').focus({preventScroll:true});
    }));
    const syncHome=()=>{
      if($('analyticsSummary'))$('homeOrders').textContent=$('analyticsSummary').textContent.replace(/^Заказов:\s*/,'').slice(0,45)||'Нет данных';
      if($('status')&&$('status').classList.contains('ok'))$('homeAccess').textContent='Доступ подтверждён';
      if($('list'))$('homeProductCount').textContent=$('list').querySelectorAll('.row').length||'0';
    };
    const observer=new MutationObserver(syncHome);
    if($('analyticsSummary'))observer.observe($('analyticsSummary'),{childList:true,subtree:true,characterData:true});
    if($('list'))observer.observe($('list'),{childList:true,subtree:true});
    if($('status'))observer.observe($('status'),{childList:true,subtree:true,attributes:true});
    syncHome();
    const preferred=(()=>{try{return sessionStorage.getItem('tihiy-admin-page')}catch(_){return null}})();
    activate(navItems.some(x=>x[0]===preferred)?preferred:'home');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();