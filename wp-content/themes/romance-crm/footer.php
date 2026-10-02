<?php
/**
 * The template for displaying the footer
 *
 * Contains the closing of the #content div and all content after.
 *
 * @link https://developer.wordpress.org/themes/basics/template-files/#template-partials
 *
 * @package romance-crm
 */

?>

	<footer class="footer mt-0 pt-4 pb-4">
			<div class="container">
				<p class="copy text-center text-white">Разработчик <a class="text-warning" href="https://rhythmdev.top">RHYTHM DEV</a></p>
			</div>
	</footer>
	<div class="modal fade" id="chatModal" tabindex="-1" aria-hidden="true">
		<div class="modal-dialog modal-dialog-scrollable modal-lg">
			<div class="modal-content">
				<div class="modal-header">
					<h5 class="modal-title">Чат с пользователем</h5>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button>
				</div>
				<div class="modal-body">
					<div class="content" id="chatModalContent">Загрузка...</div>
					<div class="writemessage d-flex align-items-center gap-2 w-100">
						<textarea class="form-control" rows="2" placeholder="Напишите сообщение..." style="resize: none; flex-grow: 1;"></textarea>
						<button class="btn btn-primary">Отправить</button>
					</div>
				</div>
			</div>
		</div>
	</div>
	<div class="modal fade" id="spamModal" tabindex="-1" aria-hidden="true">
		<div class="modal-dialog modal-dialog-scrollable modal-lg">
			<div class="modal-content">
				<div class="modal-header">
					<h5 class="modal-title">Начать рассылку</h5>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button>
				</div>
				<div class="modal-body">
					<div class="progress-status">Тут будет виден прогресс</div>
					<div class="writemessage align-items-center gap-2 w-100 mt-2">
						<div class="bg-danger text-white p-2 mb-3">
							Если вы закроете или обновите страницу, рассылка остановится и прогресс будет утерян!
						</div>
						<textarea rows="2" placeholder="Напишите сообщение..." style="resize: none; flex-grow: 1;" class="form-control mb-3"></textarea>
						<button class="btn btn-primary send-btn" >Начать</button>
						<button class="btn btn-warning" id="pauseBtn" disabled>Пауза</button>
  					<button class="btn btn-danger" id="stopBtn" disabled>Остановить</button>
					</div>
				</div>
			</div>
		</div>
	</div>
	<script src="https://code.jquery.com/jquery-3.7.1.min.js" integrity="sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=" crossorigin="anonymous"></script>
	<script src="<?php echo get_template_directory_uri(); ?>/assets/js/bootstrap.min.js"></script>
  <script src="<?php echo esc_url( get_template_directory_uri() . '/assets/js/main.js?v=' . filemtime( get_template_directory() . '/assets/js/main.js' ) ); ?>"></script>
	<?php wp_footer(); ?>
</body>
</html>