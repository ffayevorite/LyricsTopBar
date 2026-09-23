UUID = spotify-lyrics@onnichar.github.io
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas install uninstall enable disable pack

schemas:
	glib-compile-schemas schemas/

install: schemas
	mkdir -p $(dir $(EXTDIR))
	rm -rf $(EXTDIR)
	ln -s $(CURDIR) $(EXTDIR)
	@echo "linked $(EXTDIR) -> $(CURDIR)"

uninstall:
	rm -rf $(EXTDIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

pack: schemas
	gnome-extensions pack . --force \
		--extra-source=lrc.js --extra-source=lrclib.js \
		--schema=schemas/org.gnome.shell.extensions.spotify-lyrics.gschema.xml
