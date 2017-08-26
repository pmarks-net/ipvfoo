BUILDDIR := build/
NAME     := ipvfoo

all: prepare firefox chrome

prepare:
	mkdir -p build

firefox: prepare
	rm -f ${BUILDDIR}${NAME}.xpi
	cd src && zip -9r ../${BUILDDIR}${NAME}.xpi *

chrome:
	echo "Chrome build not implemented, package manually"

clean:
	rm -rf ${BUILDDIR}
