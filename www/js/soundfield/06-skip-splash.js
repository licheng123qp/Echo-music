// public/js/soundfield/06-skip-splash.js
// 去掉启动时的「点击进入」开屏。
//
// 上游的 #splash 是一段 WebGL 开场动画 + 点击进入，车机上每次开机都要多点一下，
// 而且那段动画本身就要跑几秒粒子。这里直接命中它自带的快速跳过开关
// （localStorage['mineradio-startup-fast-skip-v1'] = '1'），并在 DOM 解析完时
// 主动调一次 dismissSplash({instant:true}) 兜底。
//
// 注意：本模块必须在 js/index-loader.js 之前加载。开屏模块在脚本注入时就会读这个
// localStorage 开关，晚一步就会先播一遍动画。

(function (root) {
  'use strict';

  var FAST_SKIP_KEY = 'mineradio-startup-fast-skip-v1';

  // 1) 先落偏好：开屏模块加载时会读它，命中就直接走 instant 关闭分支
  try {
    localStorage.setItem(FAST_SKIP_KEY, '1');
  } catch (e) {
    // 隐私模式写不进 localStorage 时还有下面的主动关闭兜底
  }

  /** 立刻把开屏隐藏掉；dismissSplash 可用时走它，保证应用状态（首页/自动播放）也一起推进。 */
  function hideSplash() {
    var splash = document.getElementById('splash');
    if (!splash) return;
    // 上游会给自己加 hide 类；先手动压住，避免动画在关闭前再闪一帧
    splash.classList.add('hide');
    splash.style.display = 'none';
    if (document.body) document.body.classList.remove('splash-active', 'splash-revealing');
    if (typeof root.dismissSplash === 'function') {
      try {
        root.dismissSplash({ instant: true });
      } catch (e) {
        console.warn('[Splash] 主动关闭失败，已退化为隐藏', e);
      }
    }
  }

  // 2) DOM 一就绪就关（此脚本在 body 末尾，元素已经存在）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideSplash, { once: true });
  } else {
    hideSplash();
  }

  // 3) 再补两次：开屏模块自己的 DOMContentLoaded 监听若晚于我们注册，
  //    它可能把 splash-active 又加回来，这里保证最终状态是关掉的
  setTimeout(hideSplash, 200);
  setTimeout(hideSplash, 1200);
})(window);
