/* Reviews carousel for the homepage. No changes to the store's existing interactions. */
(()=>{
  const track=document.getElementById('homeReviewsTrack');
  const dotsWrap=document.getElementById('homeReviewDots');
  if(!track||!dotsWrap)return;
  const slides=Array.from(track.querySelectorAll('.home-review-slide'));
  const dots=Array.from(dotsWrap.querySelectorAll('[data-review-dot]'));
  const previous=document.getElementById('homeReviewPrev');
  const next=document.getElementById('homeReviewNext');
  if(!slides.length)return;
  let active=0;
  let frame=0;
  const updateDots=()=>{
    dots.forEach((dot,index)=>{
      const selected=index===active;
      dot.classList.toggle('is-active',selected);
      dot.setAttribute('aria-current',selected?'true':'false');
    });
  };
  const goTo=index=>{
    active=(index+slides.length)%slides.length;
    const slide=slides[active];
    const trackRect=track.getBoundingClientRect();
    const slideRect=slide.getBoundingClientRect();
    const left=track.scrollLeft+(slideRect.left-trackRect.left)-(track.clientWidth-slide.clientWidth)/2;
    track.scrollTo({left,behavior:'smooth'});
    updateDots();
  };
  const syncActive=()=>{
    const center=track.getBoundingClientRect().left+track.clientWidth/2;
    let nearest=0,distance=Infinity;
    slides.forEach((slide,index)=>{
      const rect=slide.getBoundingClientRect();
      const current=Math.abs(rect.left+rect.width/2-center);
      if(current<distance){distance=current;nearest=index;}
    });
    active=nearest;
    updateDots();
  };
  previous?.addEventListener('click',()=>goTo(active-1));
  next?.addEventListener('click',()=>goTo(active+1));
  dots.forEach((dot,index)=>dot.addEventListener('click',()=>goTo(index)));
  track.addEventListener('scroll',()=>{
    if(frame)return;
    frame=requestAnimationFrame(()=>{frame=0;syncActive();});
  },{passive:true});
  updateDots();
})();