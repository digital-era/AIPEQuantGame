/* manifest.js - 宣言模态框逻辑 */

function openManifestoModal() {
    const modal = document.getElementById('manifestoModal');
    const content = modal.querySelector('.modal-content');
    
    // 显示模态框背景
    modal.style.display = 'flex';
    
    // 初始化动画状态
    content.style.opacity = '0';
    content.style.transform = 'translateY(20px)';
    
    // 触发动画 (微小延迟确保过渡效果生效)
    setTimeout(() => {
        content.style.transition = 'all 0.6s cubic-bezier(0.22, 0.61, 0.36, 1)';
        content.style.opacity = '1';
        content.style.transform = 'translateY(0)';
    }, 50);
}

function closeManifestoModal() {
    const modal = document.getElementById('manifestoModal');
    modal.style.display = 'none';
}

// 点击遮罩层关闭 (事件委托)
window.addEventListener('click', function(event) {
    const modal = document.getElementById('manifestoModal');
    if (event.target === modal) {
        closeManifestoModal();
    }
});
